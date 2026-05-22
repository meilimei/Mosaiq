import { customAlphabet } from 'nanoid';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const generate = customAlphabet(alphabet, 22);

/** 为 pod 生成 machine id，与控制平面格式一致 'mch_xxx'。 */
export function newId(): string {
  return `mch_${generate()}`;
}
