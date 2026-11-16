/** Base64 helpers that work in the Workers runtime (no Buffer). */

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True for MIME types whose bytes are human-readable text. */
export function isTextMime(mime: string): boolean {
  return (
    /^text\//.test(mime) ||
    /(json|xml|csv|javascript|x-yaml|yaml)/.test(mime)
  );
}
