// Modified by ZCode Feiyu.
import { contextKey } from "../domain/protocol.js";
import { retireEnded } from "./turn-retirement.js";

export async function withControlAdmission(owner, context, execute) {
  const key = contextKey(context);
  const admission = owner.admissions.get(key) || { context, count: 0 };
  admission.count++;
  owner.admissions.set(key, admission);
  try {
    return await execute();
  } finally {
    if (--admission.count === 0) owner.admissions.delete(key);
    await retireEnded(owner);
  }
}
