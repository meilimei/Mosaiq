/**
 * 将 Zod Persona schema 导出为 JSON Schema（Draft 07），
 * 供未来 Rust / C++ 端 serde 或 mojom codegen 消费。
 *
 * 用法：
 *   import { getPersonaJsonSchema } from '@mosaiq/persona-schema';
 *   writeFileSync('persona.schema.json', JSON.stringify(getPersonaJsonSchema(), null, 2));
 */

import { zodToJsonSchema } from 'zod-to-json-schema';

import { PersonaSchema } from '../persona.js';

export function getPersonaJsonSchema() {
  return zodToJsonSchema(PersonaSchema, {
    name: 'Persona',
    $refStrategy: 'root',
    target: 'jsonSchema7',
  });
}
