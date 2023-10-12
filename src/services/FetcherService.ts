/* eslint-disable @typescript-eslint/naming-convention */
// PACKAGES
import {
	Request,
	Args,
	EResourceType,
	ICursor as IRawCursor,
	ITweet as IRawTweet,
	IUser as IRawUser,
	ITimelineTweet,
	ITimelineUser,
	IResponse,
	EErrorCodes,
} from 'rettiwt-core';
import axios, { AxiosRequestConfig, AxiosRequestHeaders, AxiosResponse } from 'axios';
import https, { Agent } from 'https';
import { AuthCredential } from 'rettiwt-auth';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ENUMS
import { EHttpStatus } from '../enums/HTTP';
import { EApiErrors } from '../enums/ApiErrors';

// MODELS
import { CursoredData } from '../models/CursoredData';
import { Tweet } from '../models/Tweet';
import { User } from '../models/User';

// HELPERS
import { findByFilter, findKeyByValue } from '../helper/JsonUtils';

/**
 * The base service that handles all HTTP requests.
 *
 * @internal
 */
export class FetcherService {
	/** The credential to use for authenticating against Twitter API. */
	private cred: AuthCredential;

	/** The HTTPS Agent to use for requests to Twitter API. */
	private readonly httpsAgent: Agent;

	/**
	 * @param apiKey - The apiKey (cookie) to use for authenticating Rettiwt against Twitter API.
	 * @param proxyUrl - Optional URL with proxy configuration to use for requests to Twitter API.
	 */
	constructor(apiKey: string, proxyUrl?: URL) {
		this.cred = this.getAuthCredential(apiKey);
		this.httpsAgent = this.getHttpsAgent(proxyUrl);
	}

	/**
	 * Returns an AuthCredential generated using the given API key.
	 *
	 * @param apiKey - The API key to use for authenticating.
	 * @returns The generated AuthCredential.
	 */
	private getAuthCredential(apiKey: string): AuthCredential {
		return new AuthCredential(apiKey.split(';'));
	}

	/**
	 * Gets the HttpsAgent based on whether a proxy is used or not.
	 *
	 * @param proxyUrl - Optional URL with proxy configuration to use for requests to Twitter API.
	 * @returns The HttpsAgent to use.
	 */
	private getHttpsAgent(proxyUrl?: URL): Agent {
		if (proxyUrl) {
			return new HttpsProxyAgent(proxyUrl);
		}

		return new https.Agent();
	}

	/**
	 * The middleware for handling any http error.
	 *
	 * @param res - The response object received.
	 * @returns The received response, if no HTTP errors are found.
	 */
	private handleHttpError(res: AxiosResponse<IResponse<unknown>>): AxiosResponse<IResponse<unknown>> {
		/**
		 * If the status code is not 200 =\> the HTTP request was not successful. hence throwing error
		 */
		if (res.status != 200 && res.status in EHttpStatus) {
			throw new Error(EHttpStatus[res.status]);
		}

		return res;
	}

	/**
	 * The middleware for handling any Twitter API-level errors.
	 *
	 * @param res - The response object received.
	 * @returns The received response, if no API errors are found.
	 */
	private handleApiError(res: AxiosResponse<IResponse<unknown>>): AxiosResponse<IResponse<unknown>> {
		// If error exists
		if (res.data.errors && res.data.errors.length) {
			// Getting the error code
			const code: number = res.data.errors[0].code;

			// Getting the error message
			const message: string = EApiErrors[
				findKeyByValue(EErrorCodes, `${code}`) as keyof typeof EApiErrors
			] as string;

			// Throw the error
			throw new Error(message);
		}

		return res;
	}

	/**
	 * Makes an HTTP request according to the given parameters.
	 *
	 * @param config - The request configuration.
	 * @returns The response received.
	 */
	private async request(config: Request): Promise<AxiosResponse<IResponse<unknown>>> {
		/**
		 * Creating axios request configuration from the input configuration.
		 */
		const axiosRequest: AxiosRequestConfig = {
			url: config.url,
			method: config.type,
			data: config.payload,
			headers: JSON.parse(JSON.stringify(this.cred.toHeader())) as AxiosRequestHeaders,
			httpsAgent: this.httpsAgent,
		};

		/**
		 * After making the request, the response is then passed to HTTP error handling middleware for HTTP error handling.
		 */
		return await axios<IResponse<unknown>>(axiosRequest)
			.then((res) => this.handleHttpError(res))
			.then((res) => this.handleApiError(res));
	}

	/**
	 * Extracts the required data based on the type of resource passed as argument.
	 *
	 * @param data - The data from which extraction is to be done.
	 * @param type - The type of data to extract.
	 * @typeParam BaseType - The base type of the raw data present in the input.
	 * @typeParam DeserializedType - The type of data produced after deserialization of BaseType.
	 * @returns The extracted data.
	 */
	private extractData<DeserializedType extends Tweet | User>(
		data: NonNullable<unknown>,
		type: EResourceType,
	): CursoredData<DeserializedType> {
		/**
		 * The required extracted data.
		 */
		let required: IRawTweet[] | IRawUser[] = [];

		if (type == EResourceType.TWEET_DETAILS) {
			required = findByFilter<IRawTweet>(data, '__typename', 'Tweet');
		} else if (type == EResourceType.USER_DETAILS || type == EResourceType.USER_DETAILS_BY_ID) {
			required = findByFilter<IRawUser>(data, '__typename', 'User');
		} else if (
			type == EResourceType.TWEET_SEARCH ||
			type == EResourceType.USER_LIKES ||
			type == EResourceType.LIST_TWEETS ||
			type == EResourceType.USER_TWEETS
		) {
			required = findByFilter<ITimelineTweet>(data, '__typename', 'TimelineTweet').map(
				(item) => item.tweet_results.result,
			);
		} else if (
			type == EResourceType.TWEET_FAVORITERS ||
			type == EResourceType.TWEET_RETWEETERS ||
			type == EResourceType.USER_FOLLOWERS ||
			type == EResourceType.USER_FOLLOWING
		) {
			required = findByFilter<ITimelineUser>(data, '__typename', 'TimelineUser').map(
				(item) => item.user_results.result,
			);
		}

		return new CursoredData(required, findByFilter<IRawCursor>(data, 'cursorType', 'Bottom')[0]?.value);
	}

	/**
	 * Fetches the requested resource from Twitter and returns it after processing.
	 *
	 * @param resourceType - The type of resource to fetch.
	 * @param args - Resource specific arguments.
	 * @typeParam OutType - The type of deserialized data returned.
	 * @returns The processed data requested from Twitter.
	 */
	protected async fetch<OutType extends Tweet | User>(
		resourceType: EResourceType,
		args: Args,
	): Promise<CursoredData<OutType>> {
		// Preparing the HTTP request
		const request: Request = new Request(resourceType, args);

		// Getting the raw data
		const res = await this.request(request).then((res) => res.data);

		// Extracting data
		const data = this.extractData<OutType>(res, resourceType);

		return data;
	}

	/**
	 * Posts the requested resource to Twitter and returns the response.
	 *
	 * @param resourceType - The type of resource to post.
	 * @param args - Resource specific arguments.
	 * @returns Whether posting was successful or not.
	 */
	protected async post(resourceType: EResourceType, args: Args): Promise<boolean> {
		// Preparing the HTTP request
		const request: Request = new Request(resourceType, args);

		// Posting the data
		const res = await this.request(request);
		return true;
	}

	async postFollow(id: string): Promise<IResponse<unknown>> {

		const params = new URLSearchParams();
		params.append('include_profile_interstitial_type', '1');
		params.append('include_blocking', '1');
		params.append('include_blocked_by', '1');
		params.append('include_followed_by', '1');
		params.append('include_want_retweets', '1');
		params.append('include_mute_edge', '1');
		params.append('include_can_dm', '1');
		params.append('include_can_media_tag', '1');
		params.append('include_ext_has_nft_avatar', '1');
		params.append('include_ext_is_blue_verified', '1');
		params.append('include_ext_verified_type', '1');
		params.append('include_ext_profile_image_shape', '1');
		params.append('user_id', id);

		const headers: AxiosRequestHeaders = JSON.parse(JSON.stringify(this.cred.toHeader())) as AxiosRequestHeaders;
		headers['Content-Type'] = 'application/x-www-form-urlencoded';

		const axiosRequest: AxiosRequestConfig = {
			url: 'https://twitter.com/i/api/1.1/friendships/create.json',
			method: 'POST',
			data: params.toString(),
			headers: headers,
		}
		return await axios<IResponse<unknown>>(axiosRequest)
			.then((res) => this.handleHttpError(res))
			.then((res) => this.handleApiError(res));
	}

	async unFollow(id: string) : Promise<IResponse<unknown>> {
		const params = new URLSearchParams();
		params.append('include_profile_interstitial_type', '1');
		params.append('include_blocking', '1');
		params.append('include_blocked_by', '1');
		params.append('include_followed_by', '1');
		params.append('include_want_retweets', '1');
		params.append('include_mute_edge', '1');
		params.append('include_can_dm', '1');
		params.append('include_can_media_tag', '1');
		params.append('include_ext_has_nft_avatar', '1');
		params.append('include_ext_is_blue_verified', '1');
		params.append('include_ext_verified_type', '1');
		params.append('include_ext_profile_image_shape', '1');
		params.append('skip_status', '1');
		params.append('user_id', id);
		const headers: AxiosRequestHeaders = JSON.parse(JSON.stringify(this.cred.toHeader())) as AxiosRequestHeaders;
		headers['Content-Type'] = 'application/x-www-form-urlencoded';

		const axiosRequest: AxiosRequestConfig = {
			url: 'https://twitter.com/i/api/1.1/friendships/destroy.json',
			method: 'POST',
			data: params.toString(),
			headers: headers,
		}
		return await axios<IResponse<unknown>>(axiosRequest)
			.then((res) => this.handleHttpError(res))
			.then((res) => this.handleApiError(res));
	}

	async getMessages(myId: string, otherId: string): Promise<IResponse<unknown>> {
		const headers: AxiosRequestHeaders = JSON.parse(JSON.stringify(this.cred.toHeader())) as AxiosRequestHeaders;
		// headers['Referer'] = `https://twitter.com/messages/${otherId}-${myId}`;
		const axiosRequest: AxiosRequestConfig = {
			url: `https://twitter.com/i/api/1.1/dm/conversation/${otherId}-${myId}.json?context=FETCH_DM_CONVERSATION&include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&dm_secret_conversations_enabled=false&krs_registration_enabled=true&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&dm_users=false&include_groups=true&include_inbox_timelines=true&include_ext_media_color=true&supports_reactions=true&include_conversation_info=true&ext=mediaColor%2CaltText%2CmediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2CsuperFollowMetadata%2CunmentionInfo%2CeditControl`,
			method: 'GET',
			// data: params.toString(),
			headers: headers,
		}
		return await axios<IResponse<unknown>>(axiosRequest)
			.then((res) => this.handleHttpError(res))
			.then((res) => this.handleApiError(res));
	}

	async sendMessage(myId: string, otherId: string, text: string, uuid: string): Promise<IResponse<unknown>> {
		const headers: AxiosRequestHeaders = JSON.parse(JSON.stringify(this.cred.toHeader())) as AxiosRequestHeaders;

		const axiosRequest: AxiosRequestConfig = {
			url: 'https://twitter.com/i/api/1.1/dm/new2.json?ext=mediaColor,altText,mediaStats,highlightedLabel,hasNftAvatar,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl&include_ext_alt_text=true&include_ext_limited_action_results=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&include_groups=true&include_inbox_timelines=true&include_ext_media_color=true&supports_reactions=true',
			method: 'POST',
			data: {
				'cards_platform': 'Web-12',
				'conversation_id': `${otherId}-${myId}`,
				'dm_users': false,
				'include_cards': 1,
				'include_quote_count': true,
				'recipient_ids': false,
				'request_id': uuid,
				'text': text,
			},
			headers: headers,
		}
		return await axios<IResponse<unknown>>(axiosRequest).then((res) => this.handleHttpError(res))
			.then((res) => this.handleApiError(res));
	}

	async replyTweet(tweetId: string, text: string): Promise<IResponse<unknown>> {
		const headers: AxiosRequestHeaders = JSON.parse(JSON.stringify(this.cred.toHeader())) as AxiosRequestHeaders;
		const axiosRequest: AxiosRequestConfig = {
			url: 'https://twitter.com' + EResourceType.CREATE_TWEET,
			method: 'POST',
			data: {
				variables: {
					tweet_text: text,
					reply: { in_reply_to_tweet_id: tweetId, exclude_reply_user_ids: [] },
					dark_request: false, media: { media_entities: [], possibly_sensitive: false },
					semantic_annotation_ids: []
				},
				features: {
					"tweetypie_unmention_optimization_enabled": true,
					"responsive_web_edit_tweet_api_enabled": true,
					"graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
					"view_counts_everywhere_api_enabled": true,
					"longform_notetweets_consumption_enabled": true,
					"responsive_web_twitter_article_tweet_consumption_enabled": false,
					"tweet_awards_web_tipping_enabled": false,
					"responsive_web_home_pinned_timelines_enabled": false,
					"longform_notetweets_rich_text_read_enabled": true,
					"longform_notetweets_inline_media_enabled": true,
					"responsive_web_graphql_exclude_directive_enabled": true,
					"verified_phone_label_enabled": false,
					"freedom_of_speech_not_reach_fetch_enabled": true,
					"standardized_nudges_misinfo": true,
					"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
					"responsive_web_media_download_video_enabled": false,
					"responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
					"responsive_web_graphql_timeline_navigation_enabled": true,
					"responsive_web_enhance_cards_enabled": false
				},
				queryId: "tTsjMKyhajZvK4q76mpIBg",
			},
			headers: headers,
		}
		return await axios<IResponse<unknown>>(axiosRequest).then((res) => this.handleHttpError(res))
			.then((res) => this.handleApiError(res));
	}

}
