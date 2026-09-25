import { httpRequest } from './http.js';
import { getLoadGuard } from '../loadGuard.js';

const UA_DJEZZY = 'Djezzy/2.6.7';
const UA_DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 9; C25Y Build/PI)';
const UA_NEW = 'Djezzy/3.0.7';
const NEW_OAUTH_BASE = 'https://apim.djezzy.dz/mobile-api';
const NEW_API_BASE = 'https://apim.djezzy.dz/mobile-api/api/v1';

const GEO_MESSAGE = '⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.';

function normalize(res, defaultStatus) {
  const status = res.status || defaultStatus;
  const isHtml = typeof res.data === 'string' && /<html|<!doctype/i.test(res.data);
  const isJsonFault = res.data && typeof res.data === 'object' && (res.data.fault || res.data.error_description);
  const isBusinessError = res.data && typeof res.data === 'object' && res.data.message && !res.data.fault;
  const raw = { status, data: res.data, via: res.via || null };
  if ((status === 403 && !isJsonFault && !isBusinessError) || isHtml || (status >= 520 && status <= 526)) {
    return { statusCode: 403, data: { message: GEO_MESSAGE, blocked: true }, raw };
  }
  return { statusCode: status, data: res.data, raw };
}

export function createDjezzy(env) {
  const base = env.API_BASE_URL_DJEZZY || 'https://apim.djezzy.dz';
  const clientId = env.DJEZZY_CLIENT_ID;
  const clientSecret = env.DJEZZY_CLIENT_SECRET;
  const clientIdV2 = env.DJEZZY_CLIENT_ID_V2 || '87pIExRhxBb3_wGsA5eSEfyATloa';
  const clientSecretV2 = env.DJEZZY_CLIENT_SECRET_V2 || 'uf82p68Bgisp8Yg1Uz8Pf6_v1XYa';

  function form(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  async function sendVerificationCode(phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/^0/, '');
    const phone = `213${cleanPhone}`;
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${base}/oauth2/registration`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_DJEZZY,
      },
      body: form({ msisdn: phone, client_id: clientId, scope: 'smsotp' }),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function verifyCode(phoneNumber, code) {
    const mobile = `213${String(phoneNumber).replace(/^0/, '')}`;
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${base}/oauth2/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_DJEZZY,
        Accept: '*/*',
      },
      body: form({
        otp: code,
        mobileNumber: mobile,
        scope: 'openid',
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'mobile',
      }),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function refreshToken(refreshToken) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${base}/oauth2/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_DALVIK,
        Accept: '*/*',
      },
      body: form({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'openid',
        client_secret: clientSecret,
        client_id: clientId,
      }),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function subscriptionProduct(phone213, accessToken, csrf, bodyData) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${base}/djezzy-api/api/v1/subscribers/${phone213}/subscription-product`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': UA_DJEZZY,
        'x-csrf-token': csrf,
        Accept: '*/*',
      },
      body: bodyData,
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function getSimInfo(phone213, accessToken) {
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${base}/djezzy-api/api/v1/subscribers/${phone213}?include=connected-products`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': UA_DJEZZY,
      },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function walkCampaign(phone213, accessToken) {
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${base}/mobile-api/api/v1/services/walk/campaign/${phone213}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'MobileApp/3.0.7',
        Accept: 'application/json',
        'Accept-Language': 'fr',
      },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function activateReward(phone213, accessToken, packageCode) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/services/walk/activate-reward/${phone213}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'MobileApp/3.0.7',
        Accept: 'application/json',
        'Accept-Language': 'fr',
      },
      body: { packageCode },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function sendInvite(subscriber213, invitedNumber, accessToken) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${base}/djezzy-api/api/v1/subscribers/${subscriber213}/member-get-member`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': UA_DJEZZY,
      },
      body: {
        data: {
          id: 'MGM-BONUS',
          type: 'products',
          meta: {
            services: {
              'b-number': invitedNumber,
              id: 'MemberGetMember',
            },
          },
        },
      },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function sendVerificationCodeV2(phoneNumber) {
    const cleanPhone = String(phoneNumber).replace(/^0/, '');
    const phone = `213${cleanPhone}`;
    return getLoadGuard('otp-djezzy', env).run(async () => {
      const res = await httpRequest(env, {
        method: 'POST',
        url: `${NEW_OAUTH_BASE}/oauth2/registration`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA_NEW,
          Accept: '*/*',
          'Cache-Control': 'no-cache',
        },
        body: form({ msisdn: phone, client_id: clientIdV2, scope: 'smsotp' }),
        relayKey: 'DJEZZY_RELAY_URL',
        useDbProxy: true,
        proxyService: 'djezzy',
        timeoutMs: 60000,
      });
      return normalize(res, 500);
    }, {
      onCircuitOpen: async () => ({ statusCode: 503, data: { message: 'الخدمة مزدحمة، أعد المحاولة لاحقًا ⚠️', blocked: true } }),
    });
  }

  async function verifyCodeV2(phoneNumber, code) {
    const mobile = `213${String(phoneNumber).replace(/^0/, '')}`;
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_OAUTH_BASE}/oauth2/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_NEW,
        Accept: '*/*',
        'Cache-Control': 'no-cache',
      },
      body: form({
        otp: code,
        mobileNumber: mobile,
        scope: 'openid',
        client_id: clientIdV2,
        client_secret: clientSecretV2,
        grant_type: 'mobile',
      }),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function refreshTokenV2(refreshToken) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_OAUTH_BASE}/oauth2/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_NEW,
        Accept: '*/*',
      },
      body: form({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'djezzyAppV2',
        client_secret: clientSecretV2,
        client_id: clientIdV2,
      }),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  function newHeaders(accessToken) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': UA_NEW,
      Accept: 'application/json',
      'Accept-Language': 'fr',
    };
  }

  async function getMainBalance(phone213, accessToken) {
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${NEW_API_BASE}/subscribers/main-balance/${phone213}`,
      headers: newHeaders(accessToken),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function getCustomerInformation(phone213, accessToken) {
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${NEW_API_BASE}/subscribers/customer-information/${phone213}`,
      headers: newHeaders(accessToken),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function getConnectedProductsBalances(phone213, accessToken) {
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${NEW_API_BASE}/subscribers/connected-products-balances/${phone213}`,
      headers: newHeaders(accessToken),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function getCustomerOffers(phone213, accessToken, tags) {
    const q = encodeURIComponent(tags || 'STANDARD,SURPRISE');
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${NEW_API_BASE}/subscribers/customer-offers/${phone213}?tags=${q}`,
      headers: newHeaders(accessToken),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function activateProduct(phone213, accessToken, packageCode, offerId) {
    const body = { packageCode };
    if (offerId) body.offerId = offerId;
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/subscribers/activate-product/${phone213}`,
      headers: newHeaders(accessToken),
      body,
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function activateWalkReward(phone213, accessToken, packageCode) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/services/walk/activate-reward/${phone213}`,
      headers: newHeaders(accessToken),
      body: { packageCode },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function activateProductV2(phone213, accessToken, packageCode) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/subscribers/activate-product/${phone213}`,
      headers: newHeaders(accessToken),
      body: { packageCode },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function getMgmInvitations(phone213, accessToken) {
    const res = await httpRequest(env, {
      method: 'GET',
      url: `${NEW_API_BASE}/services/mgm/invitations/${phone213}`,
      headers: newHeaders(accessToken),
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function sendMgmInvitation(phone213, accessToken, receiver213) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/services/mgm/send-invitation/${phone213}`,
      headers: newHeaders(accessToken),
      body: { msisdnReciever: Number(receiver213) },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function deleteMgmInvitation(phone213, accessToken, receiver213) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/services/mgm/delete-invitation/${phone213}`,
      headers: newHeaders(accessToken),
      body: { msisdnReciever: Number(receiver213) },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function resendMgmSms(phone213, accessToken, receiver213) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/services/mgm/resend-sms/${phone213}`,
      headers: newHeaders(accessToken),
      body: { msisdnReciever: Number(receiver213) },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  async function activateMgmReward(phone213, accessToken, packageCode) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${NEW_API_BASE}/services/mgm/activate-reward/${phone213}`,
      headers: newHeaders(accessToken),
      body: { packageCode },
      relayKey: 'DJEZZY_RELAY_URL',
      useDbProxy: true,
      proxyService: 'djezzy',
      timeoutMs: 60000,
    });
    return normalize(res, 500);
  }

  return {
    sendVerificationCode,
    verifyCode,
    refreshToken,
    subscriptionProduct,
    getSimInfo,
    sendInvite,
    walkCampaign,
    activateReward,
    activateWalkReward,
    activateProductV2,
    sendVerificationCodeV2,
    verifyCodeV2,
    refreshTokenV2,
    getMainBalance,
    getCustomerInformation,
    getConnectedProductsBalances,
    getCustomerOffers,
    activateProduct,
    getMgmInvitations,
    sendMgmInvitation,
    deleteMgmInvitation,
    resendMgmSms,
    activateMgmReward,
  };
}