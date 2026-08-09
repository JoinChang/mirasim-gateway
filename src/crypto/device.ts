import crypto from "node:crypto";

export interface DeviceIdentity {
  deviceId: string;
  publicKeyB64: string;
  pem: string;
  sign: (msg: string) => string;
}

const DEVICE_ID_LEN = 22;

/** Build an Ed25519 identity from a PKCS8 PEM. deviceId = sha256(pubB64).base64url[:22]. */
export function identityFromPem(pem: string): DeviceIdentity {
  const priv = crypto.createPrivateKey(pem);
  const publicKeyB64 = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64");
  const deviceId = crypto.createHash("sha256").update(publicKeyB64).digest("base64url").slice(0, DEVICE_ID_LEN);
  return {
    deviceId,
    publicKeyB64,
    pem,
    sign: (m: string) => crypto.sign(null, Buffer.from(m, "utf8"), priv).toString("base64url"),
  };
}

export function generateIdentity(): DeviceIdentity {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return identityFromPem(privateKey.export({ format: "pem", type: "pkcs8" }).toString());
}
