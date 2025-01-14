import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import base64url from "base64url";
import { Signer, Wallet, utils, providers } from "ethers";
import { Claim, IRole, IRoleDefinition } from "./LoginStrategy.types";
import { Policy } from "cockatiel";
import { IDIDDocument } from "@ew-did-registry/did-resolver-interface";
import { knownChains } from "./utils";

export class CacheServerClient {
  private readonly signer: Signer;
  private readonly httpClient: AxiosInstance;
  private readonly provider: providers.JsonRpcProvider;
  private failedRequests: Array<(token: string) => void> = [];
  private isAlreadyFetchingAccessToken = false;
  private _isAvailable = false;

  public readonly address: string;
  public get isAvailable(): boolean {
    return this._isAvailable;
  }

  constructor({
    url,
    privateKey,
    provider,
  }: {
    url: string;
    privateKey: string;
    provider: providers.JsonRpcProvider;
  }) {
    const wallet = new Wallet(privateKey, provider);
    this.address = wallet.address;
    this.signer = wallet;
    this.provider = provider;
    this.httpClient = axios.create({ baseURL: url });
    this.httpClient.interceptors.response.use(function (
      response: AxiosResponse
    ) {
      return response;
    },
    this.handleUnauthorized);
  }

  async login(): Promise<string> {
    const retry = Policy.handleAll().retry().attempts(10).delay(2000);
    retry.onFailure(({ reason }) => {
      console.log(
        `DID login strategy was not able to login to cache server due to ${JSON.stringify(
          reason,
          null,
          4
        )}`
      );
    });

    retry.onSuccess(({ duration }) => {
      console.log(
        `DID Login Strategy is now logged into cache server after ${duration}ms`
      );
    });
    const token = await retry.execute(async () => {
      const [address, blockNumber, chainId] = await Promise.all([
        this.signer.getAddress(),
        this.provider.getBlockNumber(),
        this.signer.getChainId(),
      ]);

      const { arrayify, keccak256 } = utils;
      const { encodedHeader, encodedPayload } =
        this.createLoginTokenHeadersAndPayload({
          address,
          blockNumber,
          chainName: knownChains[chainId],
        });
      const msg = `0x${Buffer.from(
        `${encodedHeader}.${encodedPayload}`
      ).toString("hex")}`;
      const sig = await this.signer.signMessage(arrayify(keccak256(msg)));
      const encodedSignature = base64url(sig);
      const data = (await this.httpClient.post<{ identityToken: string }>(
        "/login",
        {
          identityToken: `${encodedHeader}.${encodedPayload}.${encodedSignature}`,
        }
      )) as Partial<{ token: string }>;
      this!.httpClient!.defaults!.headers!.common[
        "Authorization"
      ] = `Bearer ${data.token}`;
      this._isAvailable = true;

      return data.token;
    });
    return token as string;
  }

  handleSuccessfulReLogin(token: string): void {
    this.failedRequests = this.failedRequests.filter((callback) =>
      callback(token)
    );
  }

  addFailedRequest(callback: (token: string) => void): void {
    this.failedRequests.push(callback);
  }

  handleUnauthorized = async (error: AxiosError): Promise<unknown> => {
    const { config, response } = error;
    const originalRequest = config;
    if (
      response &&
      response.status === 401 &&
      config &&
      config.url?.indexOf("/login") === -1
    ) {
      try {
        this._isAvailable = false;
        const retryOriginalRequest = new Promise((resolve) => {
          this.addFailedRequest((token) => {
            originalRequest!.headers!.Authorization = "Bearer " + token;
            resolve(axios(originalRequest));
          });
        });
        if (!this.isAlreadyFetchingAccessToken) {
          this.isAlreadyFetchingAccessToken = true;
          const token = await this.login();
          this.isAlreadyFetchingAccessToken = false;
          this.handleSuccessfulReLogin(token);
        }
        return retryOriginalRequest;
      } catch (err) {
        throw err;
      }
    }
    return Promise.reject(error);
  };

  createLoginTokenHeadersAndPayload({
    address,
    blockNumber,
    chainName,
  }: {
    address: string;
    blockNumber: number;
    chainName: string;
  }): { encodedHeader: string; encodedPayload: string } {
    const header = {
      alg: "ES256",
      typ: "JWT",
    };

    const encodedHeader = base64url(JSON.stringify(header));

    const payload = {
      iss: `did:ethr:${chainName}:${address}`,
      claimData: {
        blockNumber,
      },
    };

    const encodedPayload = base64url(JSON.stringify(payload));
    return { encodedHeader, encodedPayload };
  }

  async getRoleDefinition({
    namespace,
  }: {
    namespace: string;
  }): Promise<IRoleDefinition> {
    const { data } = await this.httpClient.get<IRole>(`/role/${namespace}`);
    return data.definition;
  }

  async getUserClaims({ did }: { did: string }): Promise<Claim[]> {
    const { data } = await this.httpClient.get<{ service: Claim[] }>(
      `/DID/${did}?includeClaims=true`
    );
    return data.service;
  }

  async getDidsWithAcceptedRole(role: string): Promise<string[]> {
    const { data } = await this.httpClient.get<string[]>(
      `/claim/did/${role}?accepted=true`
    );
    return data;
  }

  async getDidDocument(did: string): Promise<IDIDDocument> {
    const { data } = await this.httpClient.get<IDIDDocument>(
      `/DID/${did}?includeClaims=true`
    );
    return data;
  }
}
