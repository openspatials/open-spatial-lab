// gltf-webp-support.mjs: WebP textures in glTF files, on any host's Content-Security-Policy.
//
// three.js's GLTFLoader decides whether the browser can decode WebP by loading a one-pixel image from a data: URL.
// A page whose policy leaves data: out of img-src (the lab app on openspatials.com does) blocks that image, the loader
// concludes "no WebP", and a model that requires EXT_texture_webp (every avatar of the collection) fails to load with
// "WebP required by asset but unsupported". This module answers the same question by decoding the same one-pixel WebP
// with createImageBitmap from bytes in memory, which img-src does not govern, and installs that answer as the loader's
// EXT_texture_webp handler. Importing the module installs it once, for every GLTFLoader on the page; nothing else in the
// loader changes, and the textures still load through the loader's own texture path.
import { GLTFLoader } from "./vendor-three-examples/loaders/GLTFLoader.js";

const NAME = "EXT_texture_webp";
// The test image three.js uses: a lossy 1x1 WebP.
const PROBE = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
let supported = null;

export function webpSupported() {
  if (!supported) {
    supported = (async () => {
      if (typeof createImageBitmap !== "function" || typeof atob !== "function") return false;
      try {
        const bytes = Uint8Array.from(atob(PROBE), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
        const ok = bitmap.height === 1;
        bitmap.close?.();
        return ok;
      } catch {
        return false;
      }
    })();
  }
  return supported;
}

// The loader's own WebP handler, with the support test above in place of the data: image.
class WebpTextureExtension {
  constructor(parser) {
    this.parser = parser;
    this.name = NAME;
  }

  loadTexture(textureIndex) {
    const parser = this.parser;
    const json = parser.json;
    const textureDef = json.textures[textureIndex];
    if (!textureDef.extensions || !textureDef.extensions[NAME]) return null;
    const extension = textureDef.extensions[NAME];
    const source = json.images[extension.source];
    let loader = parser.textureLoader;
    if (source.uri) {
      const handler = parser.options.manager.getHandler(source.uri);
      if (handler !== null) loader = handler;
    }
    return webpSupported().then((ok) => {
      if (ok) return parser.loadTextureImage(textureIndex, extension.source, loader);
      if (json.extensionsRequired && json.extensionsRequired.includes(NAME)) {
        throw new Error("THREE.GLTFLoader: WebP required by asset but unsupported.");
      }
      return parser.loadTexture(textureIndex); // the PNG or JPEG fallback
    });
  }
}

// Registered last, so it replaces the built-in handler of the same name (the loader keys its plugins by name).
if (!GLTFLoader.prototype.__oslWebpSupport) {
  const parse = GLTFLoader.prototype.parse;
  GLTFLoader.prototype.parse = function parseWithWebpSupport(...args) {
    if (!this.__oslWebpRegistered) {
      this.register((parser) => new WebpTextureExtension(parser));
      this.__oslWebpRegistered = true;
    }
    return parse.apply(this, args);
  };
  GLTFLoader.prototype.__oslWebpSupport = true;
}
