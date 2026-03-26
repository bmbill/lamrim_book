/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 選用：南普陀 volume JSON 基底，預設為 https://cdn.amec.amrtf.org/volume/B000027 */
  readonly VITE_AMRTF_VOLUME_API_BASE?: string;
}
