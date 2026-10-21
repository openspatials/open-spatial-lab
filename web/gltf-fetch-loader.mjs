/**
 * Fetch a glTF/GLB body directly before handing its complete ArrayBuffer to
 * GLTFLoader. Three r160 FileLoader wraps response.body in a second
 * ReadableStream for progress events; Chrome 150 can report the original
 * exact request as net::ERR_ABORTED even after that wrapper decoded the body.
 * This keeps the same URL, credentials, request headers, LoadingManager, and
 * GLTFLoader parser while giving the network request one unambiguous terminal.
 */
export async function fetchAndParseGltf(loader, url) {
  const requested = loader.path ? loader.path + url : url;
  const resolved = loader.manager.resolveURL(requested);
  loader.manager.itemStart(resolved);
  try {
    const response = await fetch(resolved, {
      headers: new Headers(loader.requestHeader || {}),
      credentials: loader.withCredentials ? "include" : "same-origin",
    });
    if (!response.ok) {
      throw new Error(`fetch for "${response.url || resolved}" responded with ${response.status}: ${response.statusText}`);
    }
    const body = await response.arrayBuffer();
    const resourcePath = new URL(".", new URL(response.url || resolved, document.baseURI)).href;
    return await loader.parseAsync(body, resourcePath);
  } catch (error) {
    loader.manager.itemError(resolved);
    throw error;
  } finally {
    loader.manager.itemEnd(resolved);
  }
}
