import * as Comlink from "comlink";

export type TProviderID = string;
export type TProviderName = string;
export type TEthereumAddress = string;
export type TTokenAddress = string;
export type TENS = string;
export type TSignature = string;
export type TCSRF = string;
export type TChallenge = string;
export type TSourceId = string;
export type TClientId = string;

export type TCondition = string;
export type TMessage = string;

export type TRestriction = {
  tokenAddress: TTokenAddress;
  condition: TCondition;
  message?: TMessage;
}

export type TRestrictions = TRestriction[];

export type TLoginData = {
  csrf: TCSRF
  challenge: TChallenge
  sourceId: TSourceId
  clientId: TClientId
  restrictions?: TRestrictions
};

export const loginData = (window as any).loginData as TLoginData;

export interface IIdentity {
  name: string;
  ens: string | null;
  active: boolean;
}

export type TInitRequest = {}

export type TInitResponse = {
  name: TProviderName | null;
}

export type TConnectRequest = {
  name: TProviderName
}

export type TConnectResponse = {
  identities: IIdentity[]
}

export type TIdentitiesRequest = {

}

export type TIdentitiesResponse = {
  identities: IIdentity[]
} | null


export type TLoginResponse = {
  signature: TSignature;
  csrf: TCSRF;
  challenge: TChallenge;
  address: TEthereumAddress;
} | null

export type TLoginRequest = {
  address: TEthereumAddress
}


export type TInnerLoginRequest = {
  address: TEthereumAddress
  csrf: TCSRF
  challenge: TChallenge
}

export interface IProvider {
  init: (request: TInitRequest) => Promise<TInitResponse>;
  connect: (request: TConnectRequest) => Promise<TConnectResponse>,
  identities: (request: TIdentitiesRequest) => Promise<TIdentitiesResponse>;
  login: (request: TInnerLoginRequest) => Promise<TLoginResponse>;
  redirect: (url: string) => void;
}

interface CommunicationChannel {
  loginProvider: Comlink.Remote<IProvider> | IProvider;
}

let channel = {
  loginProvider: Comlink.wrap(Comlink.windowEndpoint(window.parent)),
} as CommunicationChannel;

function init(request: TInitRequest) {
  return channel.loginProvider.init(request);
}

function connect(request: TConnectRequest) {
  return channel.loginProvider.connect(request);
}

function identities(request: TIdentitiesRequest) {
  return channel.loginProvider.identities(request);
}

function login(request: TLoginRequest) {
  return channel.loginProvider.login({
    address: request.address,
    csrf: loginData.csrf,
    challenge: loginData.challenge,
  });
}

export interface ILoginProvider {
  loginData: TLoginData
  init: (reqeust: TInitRequest) => Promise<TInitResponse>;
  connect: (request: TConnectRequest) => Promise<TConnectResponse>,
  login: (request: TLoginRequest) => Promise<TLoginResponse>;
  identities: (request: TIdentitiesRequest) => Promise<TIdentitiesResponse>;
}

export function LoginProvider(channel: CommunicationChannel | null): ILoginProvider {
  return {
    loginData: loginData,
    init: init,
    connect: connect,
    login: login,
    identities: identities,
  }
}
