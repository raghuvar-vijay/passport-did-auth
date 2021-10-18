import {Wallet} from 'ethers';
import { ClaimsUser } from '@ew-did-registry/claims';
import { IKeys, Keys } from '@ew-did-registry/keys';
import assert from 'assert';
import { ClaimVerifier } from '../lib/ClaimVerifier';
import { Claim, IRoleDefinition } from '../lib/LoginStrategy.types';
import { ClaimData } from './claim-creation/ClaimData';
import { ClaimsUserFactory } from './claim-creation/ClaimsUserFactory';
import { mockDocument } from './TestDidDocuments';

const keys = new Keys({
  privateKey: 'de0aac51c154f9d467653ae882da9b77d0699b88d98f8bb4b03fd5e687b00824',
});

const keys2 = new Keys();

const claimsUser: ClaimsUser = ClaimsUserFactory.create(keys);
const secondClaimUser: ClaimsUser = ClaimsUserFactory.create(keys2);
const issuerDID = `did:ethr:${keys.getAddress()}`;
const secondDID = `did:ethr:${keys2.getAddress()}`;

let claims: Claim[];
let invalidClaims: Claim[];

describe("ClaimVerifier", () => {
  beforeAll(async () => {
    const claimType = "user.roles.example1.apps.john.iam.ewc";
    const claimData: ClaimData = {
      claimType
    };
    const claimToken = await claimsUser.createPublicClaim(claimData);
    const secondClaimToken = await secondClaimUser.createPublicClaim(claimData);
    const claim1: Claim = {
      claimType,
      issuedToken: claimToken,
      iss: issuerDID
    }
    const invalidClaim: Claim = {
      claimType,
      issuedToken: secondClaimToken,
      iss: issuerDID
    };
    claims = [claim1]
    invalidClaims = [invalidClaim]
  });

  it('should verify DID-type claim', async () => {
    const verifier = new ClaimVerifier(claims, getDIDTypeRoleDefinition(issuerDID), getUserClaims, getDidDocument)
    const verifiedRoles = await verifier.getVerifiedRoles();
    assert.strictEqual(verifiedRoles.length, 1);
  });

  it("should reject invalid DID-type claim", async () => {
    const verifier = new ClaimVerifier(invalidClaims, getDIDTypeRoleDefinition(secondDID), getUserClaims, getDidDocument)
    const verifiedRoles = await verifier.getVerifiedRoles();
    assert.strictEqual(verifiedRoles.length, 0);
  });

  it('should filter out claim with which does not match role definition issuer', async () => {
    const incorrectIssuerDID = "did:ethr:0x0xeBaD11b9b20Ec11F2FC44F99C21242f510B522b6";
    const verifier = new ClaimVerifier(claims, getDIDTypeRoleDefinition(incorrectIssuerDID), getUserClaims, getDidDocument);
    console.log('Verfier >> ', verifier);
    const verifiedRoles = await verifier.getVerifiedRoles();
    assert.strictEqual(verifiedRoles.length, 0);
  });
});

const getDIDTypeRoleDefinition = (issuerDid: string) => {
  const roleDef: IRoleDefinition = {
    roleName: "user",
    issuer: {
      issuerType: "DID",
      did: [issuerDid]
    }
  };
  return () => Promise.resolve(roleDef);
}

const getUserClaims: (did: string) => Promise<Claim[]> = () => {
  return Promise.resolve(new Array<Claim>());
}

const getDidDocument = async (did: string) => {
  const identity = new Wallet(keys.privateKey);
  const didDocument = mockDocument(identity);

  return didDocument;
}
