import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { predictWithLightGBM } from './lightgbm.js';
const ORIGIN = 'https://yu-makita.github.io';
const RP_ID = 'yu-makita.github.io';
const SYSTEM = 'あなたは排尿・飲水記録の補助AIです。医学的診断はしません。カフェイン・アルコールの利尿作用は個人差が大きく、予測の不確実性を示してください。飲酒を水分補給の代替として勧めないでください。JSONのみ返してください。';
const json = (data, status=200, origin=ORIGIN) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
const bad = (status, error) => json({error},status);
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromB64 = str => Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(str.length/4)*4,'=')), c=>c.charCodeAt(0));
const limit = async (env, key, max, ttl) => { const n = Number(await env.AUTH_KV.get(key)||0); if(n>=max) return false; await env.AUTH_KV.put(key,String(n+1),{expirationTtl:ttl}); return true; };

export default {
 async fetch(request,env) {
  const origin=request.headers.get('Origin');
  if(origin!==ORIGIN) return bad(403,'Origin not allowed');
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'}});
  if(request.method!=='POST') return bad(405,'Method not allowed');
  if(!env.AUTH_KV || !env.GEMINI_API_KEY || !env.SETUP_SECRET) return bad(503,'Worker secrets or KV are not configured');
  const url=new URL(request.url);
  if(Number(request.headers.get('content-length')||0)>180000) return bad(413,'Request too large');
  let body; try {body=await request.json()}catch{return bad(400,'Invalid JSON')}
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  if(!await limit(env,`requests:${ip}:${Math.floor(Date.now()/60000)}`,30,120)) return bad(429,'Too many requests');
  try {
   if(url.pathname==='/register/options') {
    if(body.setupSecret!==env.SETUP_SECRET) return bad(403,'Invalid setup secret');
    if(await env.AUTH_KV.get('credential')) return bad(409,'A passkey is already registered');
    const options=await generateRegistrationOptions({rpName:'トイレ・水分ログ',rpID:RP_ID,userName:'water-log-owner',userDisplayName:'Water Log Owner',attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'},supportedAlgorithmIDs:[-7]});
    const token=crypto.randomUUID();
    await env.AUTH_KV.put(`reg:${token}`,options.challenge,{expirationTtl:180});
    return json({options,token});
   }
   if(url.pathname==='/register/verify') {
    if(body.setupSecret!==env.SETUP_SECRET) return bad(403,'Invalid setup secret');
    if(await env.AUTH_KV.get('credential')) return bad(409,'Already registered');
    const challenge=await env.AUTH_KV.get(`reg:${body.token}`);
    if(!challenge) return bad(400,'Registration expired');
    await env.AUTH_KV.delete(`reg:${body.token}`);
    const verification=await verifyRegistrationResponse({response:body.response,expectedChallenge:challenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true});
    if(!verification.verified || !verification.registrationInfo) return bad(403,'Registration failed');
    const c=verification.registrationInfo.credential;
    await env.AUTH_KV.put('credential',JSON.stringify({id:c.id,publicKey:b64(c.publicKey),counter:c.counter,transports:body.response.response?.transports||[]}));
    return json({ok:true});
   }
   if(url.pathname==='/auth/options') {
    const raw=await env.AUTH_KV.get('credential');if(!raw)return bad(409,'Passkey not registered');
    const c=JSON.parse(raw);
    const options=await generateAuthenticationOptions({rpID:RP_ID,userVerification:'required',allowCredentials:[{id:c.id,transports:c.transports}]});
    const token=crypto.randomUUID();await env.AUTH_KV.put(`auth:${token}`,options.challenge,{expirationTtl:120});
    return json({options,token});
   }
   // AI予測と記録同期の両方でFace ID認証を行う
  if (url.pathname === '/ai' || url.pathname === '/sync') {
    const raw=await env.AUTH_KV.get('credential');if(!raw)return bad(409,'Passkey not registered');
    const c=JSON.parse(raw);
    const challenge=await env.AUTH_KV.get(`auth:${body.token}`);
    if(!challenge)return bad(403,'Authentication expired');
    await env.AUTH_KV.delete(`auth:${body.token}`);
    const result=await verifyAuthenticationResponse({response:body.assertion,expectedChallenge:challenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true,credential:{id:c.id,publicKey:fromB64(c.publicKey),counter:c.counter,transports:c.transports}});
    if(!result.verified)return bad(403,'Authentication failed');
    c.counter=result.authenticationInfo.newCounter;
    await env.AUTH_KV.put('credential',JSON.stringify(c));
    // 認証済みの記録をD1データベースへ同期する
    if (url.pathname === '/sync') {
      if (!env.water_log_db) {
        return bad(503, 'Database not configured');
      }

      const input = body.data;

      if (!input || !Array.isArray(input.entries) || input.entries.length > 5000) {
        return bad(400, 'Invalid sync data');
      }

      const entries = input.entries;

      // 不正なデータが混入していないか確認する
      for (const e of entries) {
        if (
          !e ||
          !Number.isSafeInteger(e.id) ||
          e.id < 1 ||
          !['small', 'large', 'both', 'water'].includes(e.kind) ||
          typeof e.at !== 'string' ||
          !Number.isFinite(Date.parse(e.at))
        ) {
          return bad(400, 'Invalid entry');
        }
      }

      // 端末内の全記録をサーバー側へ反映する
      // 同期失敗時に既存データを失わないよう、トランザクションで処理する
      const statements = [
        env.water_log_db.prepare('DELETE FROM entries'),
        ...entries.map(e =>
          env.water_log_db.prepare(
            `INSERT INTO entries
            (id, kind, at, category, ml, urge, urine_amount, stool, stool_amount, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            String(e.id),
            e.kind,
            e.at,
            e.category ?? null,
            e.ml ?? null,
            e.urge ?? null,
            e.urineAmount ?? null,
            e.stool ?? null,
            e.stoolAmount ?? null,
            new Date().toISOString()
          )
        )
      ];

      await env.water_log_db.batch(statements);

      return json({ ok: true, synced: entries.length });
    }
    if(!await limit(env,`ai:${Math.floor(Date.now()/86400000)}`,40,90000))return bad(429,'Daily AI limit reached');
    const input=body.data;
    if(!input || !['predict','advice'].includes(input.mode)||!Array.isArray(input.entries)||input.entries.length>1500)return bad(400,'Invalid input');
    // 次回排尿予測はGroqではなくLightGBMで実行する
    if (input.mode === 'predict') {
      if (!Array.isArray(input.entries)) {
        return bad(400, 'Invalid entries');
      }

      try {
        const remainingMinutes = predictWithLightGBM(
          input.entries,
          input.now
        );

        const nowTime = Date.parse(input.now);

        if (!Number.isFinite(nowTime)) {
          return bad(400, 'Invalid current time');
        }

        const predictedAt = new Date(
          nowTime + Math.max(1, Math.round(remainingMinutes)) * 60000
        ).toISOString();

        return json({
          predictedAt,
          rangeMinutes: 120,
          reason: '過去の排尿・飲水記録を学習したLightGBMによる予測です。学習データが少ないため、予測には大きな不確実性があります。'
        });
      } catch (error) {
        console.error('LightGBM prediction failed:', error?.message);
        return bad(422, 'LightGBM prediction unavailable');
      }
    }
    const entries=input.entries.filter(e=>e&&['small','large','both','water'].includes(e.kind)&&typeof e.at==='string').map(e=>({kind:e.kind,at:e.at.slice(0,32),category:e.category,ml:e.ml,urge:e.urge,urineAmount:e.urineAmount}));
        // 過去の排尿記録から排尿間隔の統計を計算する
    const urinations = entries
      .filter(e => e.kind === 'small' || e.kind === 'both')
      .map(e => {
        const at = e.at;

        // タイムゾーン情報がある場合はそのまま解釈する
        if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(at)) {
          return Date.parse(at);
        }

        // タイムゾーン情報がない日時は日本時間として解釈する
        return Date.parse(at + '+09:00');
      })
      .filter(t => Number.isFinite(t))
      .sort((a, b) => a - b);

    const intervals = [];

    for (let i = 1; i < urinations.length; i++) {
      const minutes = (urinations[i] - urinations[i - 1]) / 60000;

      // 連続した記録の間隔を集計する
      if (minutes > 0 && minutes <= 720) {
        intervals.push(minutes);
      }
    }

    // 数値の中央値を計算する関数
    const median = values => {
      if (values.length === 0) return null;

      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);

      return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    };

    const lastUrinationAt = urinations.length
      ? new Date(urinations[urinations.length - 1]).toISOString()
      : null;

    const medianIntervalMinutes = median(intervals);

    const recentMedianIntervalMinutes = median(intervals.slice(-5));

    const minutesSinceLastUrination = urinations.length
      ? Math.max(0, Math.round(
          (Date.parse(input.now) - urinations[urinations.length - 1]) / 60000
        ))
      : null;

    const urinationStats = {
      lastUrinationAt,
      minutesSinceLastUrination,
      medianIntervalMinutes,
      recentMedianIntervalMinutes,
      intervalCount: intervals.length
    };
    console.log('Urination stats:', JSON.stringify(urinationStats), 'Current time:', input.now);
        // AIに排尿予測・水分摂取アドバイスを指示する
        // AIに排尿予測・水分摂取アドバイスを指示する
        // AIに次回排尿までの残り時間を推定させる
    const instruction = input.mode === 'predict'
      ? `
現在時刻: ${input.now}

【排尿統計】
${JSON.stringify(urinationStats)}

【目的】
次回の排尿まで、あと何分程度かを予測してください。
日時そのものは生成しないでください。

【予測手順】
1. 最終排尿からの経過時間を確認する。
2. 過去の排尿間隔の中央値と最近の排尿間隔を確認する。
3. すでに通常の排尿間隔を超えている場合は、その事実を重視する。
4. 過去に長い排尿間隔があれば、その傾向も考慮する。
5. 直近の飲水時刻・量・種類を補助的に考慮する。
6. カフェインの影響を過大評価せず、時間的に関連する場合だけ考慮する。

【重要】
- 過去の排尿間隔の中央値を、そのまま現在時刻に加算しない。
- 通常の排尿間隔を大幅に超えている場合、短い残り時間も候補として検討する。
- 排尿間隔には個人差とばらつきがあり、尿意の情報がない場合は正確な残り時間を特定できない。
- 根拠のない生理学的説明を作らない。
- 予測の不確実性を明示する。
- 医学的診断はしない。

次のJSONのみ返してください。
{
  "remainingMinutes": 30,
  "rangeMinutes": 60,
  "reason": "日本語2文以内の予測根拠と不確実性"
}
`
      : `
現在時刻: ${input.now}
目標水分量: ${input.goalWater}mL
トイレ（小）の目安: ${input.goalSmall}回

過去の排尿・飲水記録から水分摂取の傾向を分析してください。
お酒は水分補給の代替として勧めないでください。

次のJSONのみ返してください。
{
  "advice": "日本語200字以内"
}
`;
    const model = env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    const ai = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: instruction
              + '\n排尿統計(JSON):' + JSON.stringify(urinationStats)
              + '\n記録(JSON):' + JSON.stringify(entries)
          }
        ],
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: 'json_object' }
      })
    });

    if (!ai.ok) {
      const errorText = await ai.text();
      console.error('Groq API error:', ai.status, errorText);
      return bad(502, `Groq API failed (${ai.status}): ${errorText.slice(0, 500)}`);
    }

    const payload = await ai.json();
    const output = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
        // AIが返した次回排尿時刻を検証する
        // AIが返した残り時間から次回排尿時刻を計算する
    if (input.mode === 'predict') {
      const nowTime = Date.parse(input.now);
      const remainingMinutes = Number(output.remainingMinutes);

      if (
        !Number.isFinite(nowTime) ||
        !Number.isFinite(remainingMinutes) ||
        remainingMinutes < 0 ||
        remainingMinutes > 1440
      ) {
        return bad(502, 'Invalid AI prediction');
      }

      // 予測日時はAIに生成させず、JavaScriptで計算する
      const predictedAt = new Date(
        nowTime + Math.max(1, Math.round(remainingMinutes)) * 60000
      ).toISOString();

      const rangeMinutes = Math.max(
        15,
        Math.min(240, Number(output.rangeMinutes) || 60)
      );

      return json({
        predictedAt,
        rangeMinutes,
        reason: String(output.reason || '').slice(0, 300)
      });
    }
    return json({advice:String(output.advice||'').slice(0,500)});
   }
   return bad(404,'Not found');
  } catch(e) {console.error('Worker request failed',e?.name);return bad(500,'Request failed');}
 }
};
