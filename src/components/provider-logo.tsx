import type { CSSProperties } from "react";

import anthropic from "@/assets/providers/anthropic.svg";
import claude from "@/assets/providers/claude.svg";
import deepseek from "@/assets/providers/deepseek.svg";
import gemini from "@/assets/providers/gemini.svg";
import groq from "@/assets/providers/groq.svg";
import lmstudio from "@/assets/providers/lmstudio.svg";
import mistral from "@/assets/providers/mistral.svg";
import ollama from "@/assets/providers/ollama.svg";
import openai from "@/assets/providers/openai.svg";
import openrouterDark from "@/assets/providers/openrouter-dark.svg";
import openrouterLight from "@/assets/providers/openrouter-light.svg";
import together from "@/assets/providers/together.svg";
import xai from "@/assets/providers/xai.svg";
import { Icon } from "@/icons";
import type { CliBackend, ProviderId } from "@/lib/backend";
import { cn } from "@/lib/utils";

type ProviderLogoId = ProviderId | CliBackend;
type BrandAsset = { src: string; monochrome?: boolean; darkSrc?: string };

// Official artwork, vendored without runtime requests. Asset provenance and pinned
// T3 Code/Lobe Icons source revisions are recorded in assets/providers/sources.json.
const brands: Record<Exclude<ProviderLogoId, "custom">, BrandAsset> = {
  anthropic: { src: anthropic, monochrome: true },
  openai: { src: openai, monochrome: true },
  openrouter: { src: openrouterLight, darkSrc: openrouterDark },
  groq: { src: groq },
  together: { src: together },
  mistral: { src: mistral },
  deepseek: { src: deepseek },
  xai: { src: xai, monochrome: true },
  ollama: { src: ollama, monochrome: true },
  lmstudio: { src: lmstudio },
  "claude-cli": { src: claude },
  "codex-cli": { src: openai, monochrome: true },
  "gemini-cli": { src: gemini },
};

/** A decorative provider mark beside its visible name; pass label only when standalone. */
export function ProviderLogo({
  provider,
  size,
  className,
  label,
}: {
  provider: ProviderLogoId;
  size?: number;
  className?: string;
  label?: string;
}) {
  const asset = provider === "custom" ? null : brands[provider];
  const sizing: CSSProperties | undefined = size === undefined ? undefined : { width: size, height: size };

  return (
    <span
      data-provider-logo={provider}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-(--ph-icon-size-lg) shrink-0 align-middle", className)}
      style={sizing}
    >
      {!asset ? <Icon name="tool" className="size-full" /> : asset.monochrome ? (
        <span
          data-provider-monochrome=""
          className="block size-full bg-current mask-contain mask-center mask-no-repeat"
          style={{ maskImage: `url("${asset.src}")` }}
        />
      ) : asset.darkSrc ? (
        <>
          <img src={asset.src} alt="" className="block size-full object-contain dark:hidden" draggable={false} />
          <img src={asset.darkSrc} alt="" className="hidden size-full object-contain dark:block" draggable={false} />
        </>
      ) : <img src={asset.src} alt="" className="block size-full object-contain" draggable={false} />}
    </span>
  );
}
