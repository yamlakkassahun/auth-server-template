/**
 * @description holds social login controller
 */

import {
  BuilderUtil,
  EncryptionUtil,
  HttpError,
  MessageQueueProvider,
  ParserUtil,
  PostgreSqlProvider,
  ResponseCode,
  TokenUtil,
  User,
  UserRole,
} from '@open-template-hub/common';

import axios from 'axios';
import bcrypt from 'bcrypt';
import capitalize from 'capitalize';
import OAuth from 'oauth-1.0a';
import { v4 as uuid } from 'uuid';
import { Environment } from '../../environment';
import { AuthToken } from '../interface/auth-token.interface';
import { TwoFactorCode } from '../interface/two-factor-code.interface';
import { SocialLoginRepository } from '../repository/social-login.repository';
import { TokenRepository } from '../repository/token.repository';
import { UserRepository } from '../repository/user.repository';
import { TwoFactorCodeController } from './two-factor.controller';

export class SocialLoginController {

  builder: BuilderUtil;
  parser: ParserUtil;
  environment: Environment;
  encryptionUtil: EncryptionUtil;
  tokenUtil: TokenUtil;

  constructor() {
    this.builder = new BuilderUtil();
    this.parser = new ParserUtil();
    this.environment = new Environment();
    this.encryptionUtil = new EncryptionUtil( this.environment.args() );
    this.tokenUtil = new TokenUtil( this.environment.args() );
  }

  /**
   * gets social login url
   * @param db database
   * @param data social login data
   */
  loginUrl = async ( db: PostgreSqlProvider, data: any ) => {
    let loginUrl = '';
    if ( !data.key ) {
      let e = new Error( 'key required' ) as HttpError;
      e.responseCode = ResponseCode.BAD_REQUEST;
      throw e;
    }

    const socialLoginRepository = new SocialLoginRepository( db );
    let socialLoginParams = await socialLoginRepository.findSocialLoginByKey(
        data.key
    );

    // if oauth version 2
    if ( socialLoginParams.v2Config ) {
      const params = [
        socialLoginParams.v2Config.client_id,
        data.state,
        socialLoginParams.v2Config.redirect_uri,
      ];
      loginUrl = this.builder.buildUrl(
          socialLoginParams.v2Config.login_uri,
          params
      );
    } else if ( socialLoginParams.v1Config ) {
      const oAuthRequestToken = await this.getOAuthRequestToken(
          socialLoginParams.v1Config
      );

      loginUrl = this.builder.buildUrl( socialLoginParams.v1Config.login_uri, [
        oAuthRequestToken as string,
      ] );
    }

    return loginUrl;
  };

  /**
   * login user
   * @param db database
   * @param data social login data
   */
  login = async (
      db: PostgreSqlProvider,
      messageQueueProvider: MessageQueueProvider,
      data: any
  ) => {
    if ( !data.key ) {
      let e = new Error( 'key required' ) as HttpError;
      e.responseCode = ResponseCode.BAD_REQUEST;
      throw e;
    }

    const socialLoginRepository = new SocialLoginRepository( db );
    const socialLoginParams = await socialLoginRepository.findSocialLoginByKey(
        data.key
    );

    if ( socialLoginParams.v2Config ) {
      return this.loginForOauthV2(
          db,
          messageQueueProvider,
          socialLoginParams.v2Config,
          data
      );
    } else if ( socialLoginParams.v1Config ) {
      return this.loginForOauthV1(
          db,
          messageQueueProvider,
          socialLoginParams.v1Config,
          data
      );
    } else {
      let e = new Error( 'config not found!' ) as HttpError;
      e.responseCode = ResponseCode.INTERNAL_SERVER_ERROR;
      throw e;
    }
  };

  /**
   * login user with access token
   * @param db database
   * @param data social login data
   */
  loginWithAccessToken = async (
      db: PostgreSqlProvider,
      messageQueueProvider: MessageQueueProvider,
      data: any
  ): Promise<AuthToken> => {
    try {
      const socialLoginRepository = new SocialLoginRepository( db );
      const socialLoginParams =
          await socialLoginRepository.findSocialLoginByKey( data.key );

      if ( socialLoginParams.v2Config ) {
        let accessTokenData = {
          token: data.accessToken,
          type: data.tokenType,
        };

        return await this.loginWithAccessTokenForOauthV2(
            db,
            messageQueueProvider,
            accessTokenData,
            socialLoginParams.v2Config,
            data
        );
      } else {
        throw new Error( 'Method Not Implemented' );
      }
    } catch ( e: any ) {
      console.error( e );
      e.responseCode = ResponseCode.FORBIDDEN;
      throw e;
    }
  };

  /**
   * login for oauth v1
   * @param db database
   * @param config configuration
   * @param params parameters
   */
  loginForOauthV1 = async (
      db: PostgreSqlProvider,
      messageQueueProvider: MessageQueueProvider,
      config: any,
      params: any,
      skipTwoFactorControl: boolean = false
  ) => {
    let accessTokenData = await this.getAccessTokenDataForOauthV1(
        config,
        params
    );
    if ( !accessTokenData.token ) {
      let e = new Error( 'Access token couldn\'t obtained' ) as HttpError;
      e.responseCode = ResponseCode.BAD_REQUEST;
      console.error( e );
      throw e;
    }

    let userData = accessTokenData.userData;
    if ( !userData.external_user_id ) {
      let e = new Error( 'User data couldn\'t obtained' ) as HttpError;
      e.responseCode = ResponseCode.BAD_REQUEST;
      console.error( e );
      throw e;
    }

    return this.loginUserWithUserData(
        db,
        messageQueueProvider,
        params.key,
        userData,
        skipTwoFactorControl
    );
  };

  /**
   * login for oauth v2
   * @param db database
   * @param messageQueueProvider
   * @param config configuration
   * @param params parameters
   * @param skipTwoFactorControl
   */
  loginForOauthV2 = async (
      db: PostgreSqlProvider,
      messageQueueProvider: MessageQueueProvider,
      config: any,
      params: any,
      skipTwoFactorControl: boolean = false
  ) => {
    let accessTokenData = await this.getAccessTokenDataForOauthV2(
        config,
        params
    );
    if ( !accessTokenData.token ) {
      let e = new Error( 'Access token couldn\'t obtained' ) as HttpError;
      e.responseCode = ResponseCode.BAD_REQUEST;
      console.error( e );
      throw e;
    }

    return this.loginWithAccessTokenForOauthV2(
        db,
        messageQueueProvider,
        accessTokenData,
        config,
        params,
        skipTwoFactorControl
    );
  };

  /**
   * login for oauth v2 with access token
   * @param db database
   * @param accessTokenData access token data
   * @param config configuration
   * @param params parameters
   */
  loginWithAccessTokenForOauthV2 = async (
      db: PostgreSqlProvider,
      messageQueueProvider: MessageQueueProvider,
      accessTokenData: any,
      config: any,
      params: any,
      skipTwoFactorControl: boolean = false
  ) => {
    let userData = await this.getUserDataWithAccessToken(
        accessTokenData,
        config
    );
    if ( !userData.external_user_id ) {
      let e = new Error( 'User data couldn\'t obtained' ) as HttpError;
      e.responseCode = ResponseCode.BAD_REQUEST;
      console.error( e );
      throw e;
    }

    return this.loginUserWithUserData(
        db,
        messageQueueProvider,
        params.key,
        userData,
        skipTwoFactorControl
    );
  };

  /**
   * gets user data with access token
   * @param accessTokenData access token data
   * @param config config
   */
  getUserDataWithAccessToken = async ( accessTokenData: any, config: any ) => {
    // getting user data with access token
    let userDataUrl = config.user_data_uri;
    let headers = {
      Accept: 'application/json',
      'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:44.0) Gecko/20100101 Firefox/44.0',
      Authorization: '',
      'Client-ID': config.client_id,
    };

    if ( config.requested_with_auth_header ) {
      // default authorization token type
      const tokenType = accessTokenData.type
          ? capitalize( accessTokenData.type )
          : 'Bearer';
      headers = {
        Accept: 'application/json',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:44.0) Gecko/20100101 Firefox/44.0',
        Authorization: tokenType + ' ' + accessTokenData.token,
        'Client-ID': config.client_id,
      };
    } else {
      userDataUrl = this.builder.buildUrl( config.user_data_uri, [
        accessTokenData.token,
      ] );
    }

    const userDataResponse = await axios.get<any>( `${ userDataUrl }`, {
      headers,
    } );

    const external_user_id = this.parser.getJsonValue(
        userDataResponse.data,
        config.external_user_id_json_field_path
    );
    const external_user_email = this.parser.getJsonValue(
        userDataResponse.data,
        config.external_user_email_json_field_path
    );
    const external_username = this.parser.getJsonValue(
        userDataResponse.data,
        config.external_username_json_field_path
    );

    return {
      external_user_id: external_user_id,
      external_user_email: external_user_email,
      external_username: external_username,
    };
  };

  /**
   * gets access token data for oauth v1
   * @param config configuration
   * @param params parameters
   */
  getAccessTokenDataForOauthV1 = async ( config: any, params: any ) => {
    const accessTokenParams = [ params.oauth_token, params.oauth_verifier ];
    const accessTokenUrl = this.builder.buildUrl(
        config.access_token_uri,
        accessTokenParams
    );

    let accessTokenResponse: any;

    if ( config.access_token_request_method === 'GET' ) {
      accessTokenResponse = await axios.get<any>( `${ accessTokenUrl }`, {} );
    } else if ( config.access_token_request_method === 'POST' ) {
      accessTokenResponse = await axios.post<any>( `${ accessTokenUrl }`, {} );
    }

    const urlParams = new URLSearchParams( accessTokenResponse.data );

    let oAuthTokenParam = urlParams.get(
        config.access_token_query_param_field_path
    );

    const userData = {
      external_user_id: urlParams.get(
          config.external_user_id_query_param_field_path
      ),
      external_user_email: urlParams.get(
          config.external_user_email_query_param_field_path
      ),
      external_username: urlParams.get(
          config.external_username_query_param_field_path
      ),
    };

    return {
      token: oAuthTokenParam,
      userData: userData,
    };
  };

  /**
   * gets access token data for oauth v2
   * @param config configuration
   * @param params parameters
   */
  getAccessTokenDataForOauthV2 = async ( config: any, params: any ) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    };
    const accessTokenParams = [
      config.client_id,
      config.client_secret,
      config.redirect_uri,
      params.code,
      params.state,
    ];
    const accessTokenUrl = this.builder.buildUrl(
        config.access_token_uri,
        accessTokenParams
    );

    let accessTokenResponse: any;

    if ( config.access_token_request_method === 'GET' ) {
      accessTokenResponse = await axios.get<any>( `${ accessTokenUrl }`, {
        headers,
      } );
    } else if ( config.access_token_request_method === 'POST' ) {
      accessTokenResponse = await axios.post<any>(
          `${ accessTokenUrl }`,
          {},
          { headers }
      );
    }

    const accessToken = this.parser.getJsonValue(
        accessTokenResponse.data,
        config.access_token_json_field_path
    );

    let tokenType = params.tokenType;

    if ( !tokenType ) {
      tokenType = this.parser.getJsonValue(
          accessTokenResponse.data,
          config.token_type_json_field_path
      );
    }

    return {
      token: accessToken,
      type: tokenType,
    };
  };

  /**
   * login user with user data
   * @param db database
   * @param messageQueueProvider
   * @param key social login key
   * @param userData user data
   * @param skipTwoFactorControl
   */
  loginUserWithUserData = async (
      db: PostgreSqlProvider,
      messageQueueProvider: MessageQueueProvider,
      key: string,
      userData: any,
      skipTwoFactorControl: boolean
  ): Promise<AuthToken> => {
    // checking social login mapping to determine if signup or login
    const socialLoginRepository = new SocialLoginRepository( db );
    let socialLoginUser =
        await socialLoginRepository.findMappingDataByExternalUserId(
            key,
            userData.external_user_id
        );

    const tokenRepository = new TokenRepository( db );

    if ( socialLoginUser ) {
      // login user, generate token

      const userRepository = new UserRepository( db );
      const username = socialLoginUser.username;
      let dbUser = await userRepository.findUserByUsernameOrEmail( username );

      if ( !skipTwoFactorControl && dbUser.two_factor_enabled ) {
        const environment = new Environment();
        const tokenUtil = new TokenUtil( environment.args() );
        const twoFactorCodeController = new TwoFactorCodeController();

        const user = {
          username,
        } as User;

        const preAuthToken = tokenUtil.generatePreAuthToken( user );

        const twoFactorCode = {
          username: dbUser.username,
          phoneNumber: dbUser.phone_number,
        } as TwoFactorCode;

        const twoFactorRequestResponse = await twoFactorCodeController.request(
            db,
            messageQueueProvider,
            twoFactorCode
        );

        return {
          preAuthToken,
          expiry: twoFactorRequestResponse.expire,
          maskedPhoneNumber: this.maskPhoneNumber( dbUser.phone_number ),
        } as any;
      } else {
        return tokenRepository.generateTokens( socialLoginUser );
      }
    } else {
      // signup user and generate token
      const autoGeneratedUserName = uuid();
      const autoGeneratedPassword = uuid();

      socialLoginUser = {
        username: autoGeneratedUserName,
        password: autoGeneratedPassword,
        email: userData.external_user_email,
        role: UserRole.DEFAULT,
      };

      await this.signup( db, socialLoginUser );
      await socialLoginRepository.insertSocialLoginMapping(
          key,
          userData.external_user_id,
          userData.external_username,
          userData.external_user_email,
          autoGeneratedUserName
      );

      return tokenRepository.generateTokens( socialLoginUser );
    }
  };

  /**
   * sign up user
   * @param db database
   * @param user user
   */
  signup = async ( db: PostgreSqlProvider, user: User ) => {
    const hashedPassword = await bcrypt.hash( user.password, 10 );

    const userRepository = new UserRepository( db );
    await userRepository.insertUser( {
      username: user.username,
      password: hashedPassword,
      role: UserRole.DEFAULT,
    } as User );
    await userRepository.verifyUser( user.username );
  };

  /**
   * gets oauth request token
   * @param config configuration
   */
  getOAuthRequestToken = async ( config: any ) => {
    const oauth = new OAuth( {
      consumer: {
        key: config.client_id,
        secret: config.client_secret,
      },
      signature_method: 'HMAC-SHA1',
      hash_function: this.encryptionUtil.hash_function_sha1,
    } );

    const request_data = {
      url: config.request_token_uri,
      method: 'POST',
      data: { oauth_callback: config.redirect_uri },
    };

    let headers = oauth.toHeader( oauth.authorize( request_data ) );

    let axiosHeader: Record<string, string> = {};
    axiosHeader.Authorization = headers.Authorization;

    const oAuthRequestTokenResponse: any = await axios.post<any>(
        `${ config.request_token_uri }`,
        {},
        { headers: axiosHeader }
    );

    const urlParams = new URLSearchParams( oAuthRequestTokenResponse.data );

    if ( urlParams.has( 'oauth_token' ) ) {
      return urlParams.get( 'oauth_token' );
    }

    return '';
  };

  private maskPhoneNumber( number: string ): string {
    let maskedNumber = '';
    for ( let i = 0; i < number.length; i++ ) {
      if ( i > number.length - 3 ) {
        maskedNumber += number.charAt( i );
      } else {
        maskedNumber += '*';
      }
    }
    return maskedNumber;
  }
}
