---
name: image-generation
description: Use the configured GenerateImage tool for user-requested image generation or editing. Requires the image service to be enabled for this session.
---

# Image generation

Use GenerateImage when available. Preserve explicit width/height, count and format; PNG and one image are defaults. Ask only when missing information would materially change the requested result. Describe composition, subjects and constraints in the prompt. For edits, explicitly preserve unrequested parts and pass authorized referenceImages.

Do not use shell/network tools to bypass a disabled provider or subagent cost policy. Subagents need the separate setting enabled. The tool runs in the current session and uses its trusted Host configuration; no credentials belong in prompts.

The tool shows loading while queued, generating and saving, then displays the original images. Do not generate extra paid variants for self-review. On failure inspect ManageImageGeneration; resume a known generationId to retrieve the same request. An unknown submission must not be replaced automatically. User stop does not authorize automatic resumption.

Use local artifact references for follow-up editing. If an image is needed in a project, copy/export only the requested result with existing file tools and preserve the original artifact. Unsupported exact dimensions/format/count should be reported rather than silently replaced.
