import { describe, expect, it } from "vitest";
import { accountStore } from "../../src/accounts/store.js";
import { isSealed } from "../../src/crypto/secretbox.js";
import { memDb } from "../../src/db/client.js";
import { accountsRepo } from "../../src/db/repositories/accounts.js";

describe("accountStore", () => {
  it("seals secrets at rest, decrypts on read (with master key)", () => {
    const db = memDb();
    const key = Buffer.alloc(32, 3);
    const store = accountStore({ db, masterKey: key });
    store.add({ id: "usr_1", email: "a@b.c", plan: "max", refreshToken: "RT", devicePrivateKey: "PEM" });
    const raw = accountsRepo(db).get("usr_1")!;
    expect(isSealed(raw.refreshToken)).toBe(true);
    expect(isSealed(raw.devicePrivateKey!)).toBe(true);
    const dec = store.get("usr_1")!;
    expect(dec.refreshToken).toBe("RT");
    expect(dec.devicePrivateKey).toBe("PEM");
  });
  it("stores plaintext when no master key", () => {
    const db = memDb();
    const store = accountStore({ db, masterKey: null });
    store.add({ id: "u", refreshToken: "RT" });
    expect(accountsRepo(db).get("u")!.refreshToken).toBe("RT");
    expect(store.get("u")!.refreshToken).toBe("RT");
  });
  it("shared device key round-trips via kv", () => {
    const db = memDb();
    const store = accountStore({ db, masterKey: Buffer.alloc(32, 5) });
    expect(store.getSharedDeviceKey()).toBeNull();
    store.setSharedDeviceKey("DEVPEM");
    expect(store.getSharedDeviceKey()).toBe("DEVPEM");
  });
});
