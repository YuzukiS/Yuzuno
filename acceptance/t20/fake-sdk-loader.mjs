// node --import fake-sdk-loader.mjs bridge.mjs: the real bridge, fake SDK.
import { register } from 'node:module';

register('./fake-sdk-hooks.mjs', import.meta.url);
