// Modified by ZCode Feiyu contributors (2026).
import { useRef, useState } from "react";
import { ImageIcon, LoaderCircle } from "lucide-react";
import type { GeneratedImage } from "@zcode/shared";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { useGeneratedImages } from "@/hooks/useGeneratedImages.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

function GeneratedImageGallery({ images }: { images: readonly GeneratedImage[] }) {
  const { intl } = useZCodeIntl();
  const { items, loading, error } = useGeneratedImages(images);
  const [open, setOpen] = useState(false),
    [index, setIndex] = useState(0);
  const triggers = useRef<Array<HTMLButtonElement | null>>([]);
  if (loading) return <ImageGenerationLoading />;
  if (error)
    return (
      <p role="alert" className="text-ui-caption text-destructive">
        {error}
      </p>
    );
  return (
    <>
      <ImageThumbnailGallery data-image-generation-gallery="" grouped={items.length >= 2}>
        {items.map((item, position) => (
          <button
            key={item.src}
            type="button"
            data-image-thumbnail-trigger=""
            className={imageThumbnailTriggerClassName}
            ref={(element) => {
              triggers.current[position] = element;
            }}
            aria-label={`${intl.formatMessage({ id: "chat.attachments.preview.open" })} ${position + 1}`}
            onClick={() => {
              setIndex(position);
              setOpen(true);
            }}
          >
            <img
              className={imageThumbnailClassName}
              src={item.src}
              alt={item.alt}
              loading="lazy"
              draggable={false}
            />
          </button>
        ))}
      </ImageThumbnailGallery>
      <ImagePreviewDialog
        items={items}
        initialIndex={index}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) requestAnimationFrame(() => triggers.current[index]?.focus());
        }}
        dialogTestId="image-generation-preview"
        imageTestId="image-generation-preview-image"
      />
    </>
  );
}
function ImageGenerationLoading() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex items-center gap-2 rounded-md bg-surface p-4 text-ui-caption text-foreground-subtle"
      role="status"
      aria-live="polite"
      data-image-generation-loading=""
    >
      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {intl.formatMessage({ id: "imageGeneration.loading" })}
    </div>
  );
}
export function ImageGenerationToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const generated = display?.kind === "image_generation" ? display : undefined;
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={<ImageIcon className="size-4 text-foreground-subtle" />}
      kindLabel={intl.formatMessage({ id: "imageGeneration.title" })}
      primaryText={
        context.isRunning
          ? intl.formatMessage({ id: "imageGeneration.loading" })
          : context.statusLabel
      }
      isRunning={context.isRunning}
      autoOpen
      autoCollapseOnComplete={false}
      showFailureStatus={Boolean(context.errorText)}
      statusLabel={context.errorText}
      forceOpen={context.isRunning}
      content={
        <div className="space-y-3">
          {context.isRunning ? <ImageGenerationLoading /> : null}
          {generated?.images.length ? <GeneratedImageGallery images={generated.images} /> : null}
          {generated?.message ? (
            <p className="text-ui-caption text-foreground-subtle">{generated.message}</p>
          ) : null}
          {context.errorText ? (
            <p role="alert" className="text-ui-caption text-destructive">
              {context.errorText}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
