// Types for the React Bits <Dither /> component (Dither.jsx), so the TypeScript app can import it.
import type { CSSProperties, FC } from "react";

type Color = string | [number, number, number];

export interface DitherProps {
  waveColor?: Color;
  backgroundColor?: Color | "transparent";
  ditherMode?: "bayer" | "bayer4" | "bayer2" | "halftone" | "lines" | "crosshatch" | "noise" | "none";
  palette?: string[];
  colorNum?: number;
  pixelSize?: number;
  scale?: number;
  waveSpeed?: number;
  waveFrequency?: number;
  waveAmplitude?: number;
  contrast?: number;
  brightness?: number;
  enableMouseInteraction?: boolean;
  mouseEffect?: "erase" | "reveal" | "ripple";
  mouseRadius?: number;
  mouseStrength?: number;
  trail?: number;
  clickRipple?: boolean;
  intro?: boolean;
  disableAnimation?: boolean;
  dpr?: number;
  className?: string;
  style?: CSSProperties;
}

declare const Dither: FC<DitherProps>;
export default Dither;
