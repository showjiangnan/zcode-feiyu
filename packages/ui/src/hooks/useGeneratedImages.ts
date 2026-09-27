import { useEffect, useState } from "react";
import { generatedImageSchema, type GeneratedImage } from "@zcode/shared";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

export function useGeneratedImages(images: readonly GeneratedImage[]) {
  const manifest = JSON.stringify(images);
  const { attachmentRead } = useV4Conversation();
  const [state, setState] = useState<{
    items: Array<{ src: string; filename: string; alt: string }>;
    loading: boolean;
    error?: string;
  }>({ items: [], loading: false });
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    const selected = generatedImageSchema.array().parse(JSON.parse(manifest));
    setState({ items: [], loading: selected.length > 0 });
    void (async () => {
      try {
        const items = [];
        for (const image of selected) {
          const uri = new URL(image.ref);
          if (uri.protocol !== "zcode-artifact:")
            throw new Error("Invalid generated image reference.");
          const result = await attachmentRead({
            sessionId: decodeURIComponent(uri.hostname),
            ref: image.ref,
            mediaType: image.mime,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          const src =
            "url" in result
              ? result.url
              : URL.createObjectURL(
                  new Blob([new Uint8Array(result.bytes)], { type: result.mediaType }),
                );
          if (!("url" in result)) urls.push(src);
          items.push({ src, filename: image.fileName, alt: image.fileName });
        }
        if (!controller.signal.aborted) setState({ items, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            items: [],
            loading: false,
            error: error instanceof Error ? error.message : "Image unavailable",
          });
      }
    })();
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [attachmentRead, manifest]);
  return state;
}
