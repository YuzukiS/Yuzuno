// Module hooks: the bridge's SDK import resolves to fake-sdk.mjs.
export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: new URL('./fake-sdk.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
