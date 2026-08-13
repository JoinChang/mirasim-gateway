import { open, seal } from "../crypto/secretbox.js";
import type { DB } from "../db/client.js";
import { accountsRepo } from "../db/repositories/accounts.js";
import { kvRepo } from "../db/repositories/kv.js";

export interface DecryptedAccount {
  id: string;
  email: string;
  plan: string;
  refreshToken: string;
  devicePrivateKey: string | null;
  disabledUntil: number;
  consecutiveFails: number;
  lastUsedAt: number;
  lastUtilization: number;
  createdAt: number;
}

const SHARED_DEVICE_KEY = "shared_device_key";

export function accountStore(opts: { db: DB; masterKey: Buffer | null }) {
  const repo = accountsRepo(opts.db);
  const kv = kvRepo(opts.db);
  const mk = opts.masterKey;
  const dec = (a: ReturnType<typeof repo.get>): DecryptedAccount | undefined =>
    a && {
      ...a,
      refreshToken: open(a.refreshToken, mk),
      devicePrivateKey: a.devicePrivateKey ? open(a.devicePrivateKey, mk) : null,
    };

  return {
    add(rec: {
      id: string;
      email?: string;
      plan?: string;
      refreshToken: string;
      devicePrivateKey?: string | null;
    }): void {
      repo.upsert({
        id: rec.id,
        email: rec.email ?? "",
        plan: rec.plan ?? "",
        refreshToken: mk ? seal(rec.refreshToken, mk) : rec.refreshToken,
        devicePrivateKey: rec.devicePrivateKey ? (mk ? seal(rec.devicePrivateKey, mk) : rec.devicePrivateKey) : null,
      });
    },
    get: (id: string) => dec(repo.get(id)),
    list: (): DecryptedAccount[] => repo.list().map((a) => dec(a)!),
    remove: (id: string) => repo.remove(id),
    setDisabledUntil: (id: string, ms: number) => repo.setDisabledUntil(id, ms),
    setUtilization: (id: string, u: number) => repo.setUtilization(id, u),
    setLastUsed: (id: string, ms: number) => repo.setLastUsed(id, ms),
    setFails: (id: string, n: number) => repo.setFails(id, n),
    setProfile: (id: string, p: { email?: string; plan?: string }) => repo.setProfile(id, p),
    setRefreshToken: (id: string, plain: string) => repo.setRefreshToken(id, mk ? seal(plain, mk) : plain),
    setDeviceKey: (id: string, pem: string) => repo.setDeviceKey(id, mk ? seal(pem, mk) : pem),
    getSharedDeviceKey: (): string | null => {
      const v = kv.get(SHARED_DEVICE_KEY);
      return v ? open(v, mk) : null;
    },
    setSharedDeviceKey: (pem: string) => kv.set(SHARED_DEVICE_KEY, mk ? seal(pem, mk) : pem),
  };
}
export type AccountStore = ReturnType<typeof accountStore>;
