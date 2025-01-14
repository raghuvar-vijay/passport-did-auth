import { providers } from "ethers";

import { getServer } from "./testUtils/server";
import { preparePassport } from "./testUtils/preparePassport";
import {
  setChainConfig,
  DIDAttribute,
  initWithPrivateKeySigner,
  ClaimsService,
  AssetsService,
  DidRegistry,
  setCacheConfig,
} from "iam-client-lib";
import ServerMock from "mock-http-server";
import { Encoding, PubKeyType } from "@ew-did-registry/did-resolver-interface";

import request from "supertest";

import { JWT } from "@ew-did-registry/jwt";
import { Keys, KeyType } from "@ew-did-registry/keys";

import {
  assetsManager,
  claimManager,
  deployClaimManager,
  deployDidRegistry,
  deployEns,
  deployIdentityManager,
  didContract,
  domainNotifer,
  ensRegistry,
  ensResolver,
} from "./setup_contracts";
import { assert } from "chai";

const GANACHE_PORT = 8544;
const rpcUrl = `http://localhost:${GANACHE_PORT}`;

const provider = new providers.JsonRpcProvider(rpcUrl);

// funded private key for 0x627306090abaB3A6e1400e9345bC60c78a8BEf57
// ganache with "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat" mnemonic
const userPrivKey =
  "0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3";
const userAddress = "0x627306090abaB3A6e1400e9345bC60c78a8BEf57";
const userDid = `did:ethr:volta:${userAddress}`;

const secondPrivKey =
  "ae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f";
const secondAddress = "0xf17f52151EbEF6C7334FAD080c5704D77216b732";
const secondDid = `did:ethr:volta:${secondAddress}`;

jest.setTimeout(84000);

interface IAM {
  claimsService?: ClaimsService;
  assetService?: AssetsService;
  didRegistry?: DidRegistry;
}

const iam: IAM = {};

const server = new ServerMock({ host: "localhost", port: 9000 });
const asyncStart = () => new Promise((resolve) => server.start(resolve));
const asyncStop = () => new Promise((resolve) => server.stop(resolve));

let getOwnedAssets: jest.SpyInstance;

beforeAll(async () => {
  await deployDidRegistry();
  await deployEns();
  await deployClaimManager();
  await deployIdentityManager();

  await asyncStart();

  server.on({
    method: "POST",
    path: "/login",
    reply: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    },
  });

  const { chainId } = await provider.getNetwork();
  setChainConfig(chainId, {
    rpcUrl,
    chainName: "volta",
    didRegistryAddress: didContract.address,
    ensRegistryAddress: ensRegistry.address,
    ensResolverAddress: ensResolver.address,
    assetManagerAddress: assetsManager.address,
    claimManagerAddress: claimManager.address,
    domainNotifierAddress: domainNotifer.address,
    ensPublicResolverAddress: ensRegistry.address,
    stakingPoolFactoryAddress: ensRegistry.address,
  });

  setCacheConfig(chainId, {
    url: "http://localhost:9000/",
    cacheServerSupportsAuth: false,
  });

  const { connectToCacheServer } = await initWithPrivateKeySigner(
    userPrivKey,
    rpcUrl
  );
  const { connectToDidRegistry, assetsService } = await connectToCacheServer();

  const { claimsService, didRegistry } = await connectToDidRegistry();
  iam.claimsService = claimsService;
  iam.assetService = assetsService;
  iam.didRegistry = didRegistry;

  jest
    .spyOn(iam.assetService, "getAssetById")
    .mockResolvedValue(undefined as any);
  getOwnedAssets = jest.spyOn(iam.assetService, "getOwnedAssets");
});

afterAll(async () => {
  await asyncStop();
});

it("Verifies asset authentication", async () => {
  // Register an asset
  const assetAddress = await iam.assetService!.registerAsset();
  assert.exists(assetAddress);

  // Create a key
  const assetKeys = new Keys();

  // Add new key to asset's DID Document
  const assetDid = `did:ethr:volta:${assetAddress}`;
  getOwnedAssets.mockResolvedValueOnce([
    { document: { id: assetDid }, id: assetDid },
  ]);
  const isDIdDocUpdated = await iam.didRegistry!.updateDocument({
    didAttribute: DIDAttribute.PublicKey,
    did: assetDid,
    data: {
      algo: KeyType.Secp256k1,
      encoding: Encoding.HEX,
      type: PubKeyType.SignatureAuthentication2018,
      value: { tag: "key-1", publicKey: `0x${assetKeys.publicKey}` },
    },
  });
  assert.isTrue(isDIdDocUpdated, "The asset has not been added to document");
  const token = await iam.claimsService!.createDelegateProof(
    assetKeys.privateKey,
    assetDid
  );
  const identityToken = token;
  const server = getServer(didContract.address);
  const connection = server.listen(4242, () => {
    console.log("Test Server is ready and listening on port 4242");
  });
  const response = await request(server).post("/login").send({ identityToken });
  expect(response.statusCode).toBe(200);
  expect(response.body.token).toBeDefined();
  connection.close();
});

it("Should authenticate issuer signature", async () => {
  const { loginStrategy } = preparePassport(didContract.address);
  const token = await iam.claimsService!.createIdentityProof();
  const payload = {
    iss: `did:ethr:${userAddress}`,
    claimData: {
      blockNumber: 4242,
    },
    sub: "",
  };

  await loginStrategy?.validate(token, payload, (err, user) => {
    const jwt = new JWT(new Keys({ privateKey: userPrivKey }));
    const decodedIdentity = jwt.decode(token) as {
      [key: string]: string | object;
    };
    const decodedVerifiedUser = jwt.decode(user) as {
      [key: string]: string | object;
    };
    expect(decodedVerifiedUser.did).toBe(decodedIdentity.did);
  });
});

it("Should reject invalid issuer", async () => {
  const { loginStrategy } = preparePassport(didContract.address);
  const token = await iam.claimsService!.createIdentityProof();
  const payload = {
    iss: secondDid,
    claimData: {
      blockNumber: 4242,
    },
    sub: "",
  };

  const consoleListener = jest.spyOn(console, "log");
  await loginStrategy?.validate(token, payload, () => {
    expect(consoleListener).toBeCalledWith("Not Verified");
  });
});

it("Should reject invalid token", async () => {
  const { connectToCacheServer } = await initWithPrivateKeySigner(
    secondPrivKey,
    rpcUrl
  );
  const { connectToDidRegistry } = await connectToCacheServer();
  const { claimsService } = await connectToDidRegistry();
  const { loginStrategy } = preparePassport(didContract.address);
  const token = await claimsService.createIdentityProof();
  const payload = {
    iss: userDid,
    claimData: {
      blockNumber: 4242,
    },
    sub: "",
  };

  const consoleListener = jest.spyOn(console, "log");
  await loginStrategy?.validate(token, payload, () => {
    expect(consoleListener).toBeCalledWith("Not Verified");
  });
});
