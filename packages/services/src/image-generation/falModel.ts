import type { ImageGenerationInput } from "@zcode/shared";

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : {};

/** Resolve only local OpenAPI references. Remote $ref is never fetched. */
export function resolveFalInputSchema(document: unknown): Schema {
  const doc = object(document);
  // HTTP 200 也可能携带 schema 获取错误；不泄露提供商正文，也不误报模型没有输入契约。
  if ("error" in doc) throw new Error("Image provider failed to load the model input schema.");
  const resolve = (value: unknown, depth = 0): Schema => {
    if (depth > 20) throw new Error("Image model schema is recursive or too deep.");
    const current = object(value);
    if (typeof current.$ref === "string") {
      if (!current.$ref.startsWith("#/"))
        throw new Error("Remote image schema references are unsupported.");
      const target = current.$ref
        .slice(2)
        .split("/")
        .reduce<unknown>(
          (node, key) => object(node)[key.replace(/~1/g, "/").replace(/~0/g, "~")],
          doc,
        );
      return resolve(target, depth + 1);
    }
    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => [
        key,
        key === "properties"
          ? Object.fromEntries(
              Object.entries(object(child)).map(([name, schema]) => [
                name,
                resolve(schema, depth + 1),
              ]),
            )
          : ["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(child)
            ? child.map((schema) => resolve(schema, depth + 1))
            : key === "items"
              ? resolve(child, depth + 1)
              : child,
      ]),
    );
  };
  for (const path of Object.values(object(doc.paths))) {
    const content = object(object(object(object(path).post).requestBody).content);
    const schema = object(content["application/json"]).schema;
    if (schema) return resolve(schema);
  }
  const schemas = object(object(doc.components).schemas);
  const input = schemas.Input ?? Object.entries(schemas).find(([key]) => /input$/i.test(key))?.[1];
  if (!input) throw new Error("Image model does not publish a supported input schema.");
  return resolve(input);
}

function accepts(schema: Schema, value: unknown): boolean {
  for (const union of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[union]))
      return schema[union].some((item) => accepts(object(item), value));
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => accepts(object(item), value)))
    return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof value === "number") {
    if (schema.type && schema.type !== "number" && schema.type !== "integer") return false;
    if (schema.type === "integer" && !Number.isInteger(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      return false;
    if (typeof schema.multipleOf === "number" && value % schema.multipleOf !== 0) return false;
  } else if (typeof value === "string") {
    if (schema.type && schema.type !== "string") return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  } else if (Array.isArray(value)) {
    if (schema.type && schema.type !== "array") return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    return value.every((item) => accepts(object(schema.items), item));
  } else if (value && typeof value === "object") {
    if (schema.type && schema.type !== "object") return false;
    const props = object(schema.properties);
    if (Array.isArray(schema.required) && !schema.required.every((key) => String(key) in value))
      return false;
    return Object.entries(value).every(
      ([key, item]) => key in props && accepts(object(props[key]), item),
    );
  }
  return true;
}

export function mapImageInput(
  schema: Schema,
  input: ImageGenerationInput,
  references: string[],
): Schema {
  const props = object(schema.properties);
  const result: Schema = {};
  const set = (key: string, value: unknown) => {
    if (!(key in props) || !accepts(object(props[key]), value))
      throw new Error(`Image model does not support the requested ${key}.`);
    result[key] = value;
  };
  set("prompt", input.prompt);
  // PNG 必须显式请求，不能因提供商默认 JPEG 而静默改变用户的输出格式。
  set("output_format", input.format);
  if ("num_images" in props) set("num_images", input.count);
  else if (input.count !== 1)
    throw new Error("Image model does not support the requested image count.");
  if (input.width !== undefined) {
    if ("image_size" in props) set("image_size", { width: input.width, height: input.height });
    else {
      set("width", input.width);
      set("height", input.height);
    }
  }
  if (references.length) {
    if ("image_urls" in props) set("image_urls", references);
    else if (references.length === 1) set("image_url", references[0]);
    else throw new Error("Image model supports only one reference image.");
  }
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!(String(key) in result) && object(props[String(key)]).default === undefined)
      throw new Error(`Image model requires unsupported input: ${String(key)}.`);
  }
  return result;
}
