import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

async function post(url:string,path:string,body:unknown){
 const res=await fetch(url.replace(/\/$/,'')+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json();if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);return data;
}

// Face IDなどの端末認証を使用するパスキーを初回登録する関数
export async function registerPasskey(url:string,setupSecret:string){
 const {options,token}=await post(url,'/register/options',{setupSecret});
 const response=await startRegistration({optionsJSON:options});
 await post(url,'/register/verify',{setupSecret,token,response});
}

// AI予測・記録同期の実行前にパスキー認証を行う関数
export async function callAuthenticatedAI(
  url: string,
  data: unknown,
  path: '/ai' | '/sync' | '/model/update' = '/ai'
) {
  const { options, token } = await post(url, '/auth/options', {});

  const assertion = await startAuthentication({
    optionsJSON: options
  });

  return post(url, path, {
    token,
    assertion,
    data
  });
}
