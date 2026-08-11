// Remote media is not represented by the serialized request bytes: an `https:` URL can be tiny while the
// provider dereferences it into a much larger billable input. Every hold estimator can eventually fall back
// to the deterministic byte bound, and Tinfoil always uses it, so reject known remote-image shapes uniformly
// until each provider has a separately proven worst-case media reservation. Inline `data:`/base64 bytes stay
// allowed because their full representation is covered by the byte-bound proof.

function remoteHttpUrl(value: unknown): boolean {
  return typeof value === "string" && /^\s*https?:\/\//i.test(value);
}

export function hasRemoteChatImage(body: any): boolean {
  return (
    Array.isArray(body?.messages) &&
    body.messages.some(
      (message: any) =>
        Array.isArray(message?.content) &&
        message.content.some((part: any) => {
          if (part?.type !== "image_url") return false;
          const value = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          return remoteHttpUrl(value);
        }),
    )
  );
}

export function hasRemoteResponsesImage(body: any): boolean {
  return (
    Array.isArray(body?.input) &&
    body.input.some(
      (item: any) =>
        Array.isArray(item?.content) &&
        item.content.some((part: any) => part?.type === "input_image" && remoteHttpUrl(part.image_url)),
    )
  );
}

export function hasRemoteAnthropicImage(body: any): boolean {
  return (
    Array.isArray(body?.messages) &&
    body.messages.some(
      (message: any) =>
        Array.isArray(message?.content) &&
        message.content.some(
          (part: any) => part?.type === "image" && part.source?.type === "url" && remoteHttpUrl(part.source?.url),
        ),
    )
  );
}
