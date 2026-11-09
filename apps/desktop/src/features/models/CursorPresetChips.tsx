import type { ModelType } from "../../shared/api";
import { magpiePresetIcon, modelPresets, presetEndpoint, trimTrailingSlash, type ModelPreset } from "../../shared/utils/modelPresets";
import styles from "./CursorPresetChips.module.scss";

export type MagpieChip = {
  busy: boolean;
  onPick: () => void;
};

/** 常用服务商预设：点击按当前协议类型自动填充对应端点与默认模型 */
export function CursorPresetChips({ type, baseUrl, magpie, onPick }: { type: ModelType; baseUrl: string; magpie: MagpieChip; onPick: (preset: ModelPreset) => void }) {
  return <div className={styles.wrap}>
    <span className={styles.label}>{t("常用预设")}</span>
    <div className={styles.chips}>
      {modelPresets.map((preset) => {
        const active = trimTrailingSlash(baseUrl) === trimTrailingSlash(presetEndpoint(preset, type).baseUrl);
        return <button
          type="button"
          key={preset.key}
          className={active ? `${styles.chip} ${styles.active}` : styles.chip}
          title={preset.keyHint}
          onClick={() => onPick(preset)}
        >
          <img className={styles.icon} src={preset.icon} alt="" />
          {preset.name}
        </button>;
      })}
      {/* Magpie 不是字段预设:它查询本机网关并批量建模型,所以不进入 modelPresets。
          它会另开一个弹窗,因此由调用方先关闭当前弹窗再打开。 */}
      <button
        type="button"
        className={styles.chip}
        title={t("查询本机 magpie 网关并批量导入其模型")}
        disabled={magpie.busy}
        aria-haspopup="dialog"
        onClick={magpie.onPick}
      >
        <img className={styles.icon} src={magpiePresetIcon} alt="" />
        Magpie
      </button>
    </div>
  </div>;
}
