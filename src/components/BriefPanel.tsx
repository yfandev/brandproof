import type { SceneId } from '../types';
import { SCENES } from '../lib/scenes';
import { Card, Field, Pill } from './ui';

interface BriefPanelProps {
  brand: string;
  labelText: string;
  scene: SceneId;
  prompt: string;
  promptDirty: boolean;
  onBrandChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  onSceneChange: (value: SceneId) => void;
  onPromptChange: (value: string) => void;
  onResetPrompt: () => void;
}

export function BriefPanel({
  brand,
  labelText,
  scene,
  prompt,
  promptDirty,
  onBrandChange,
  onLabelChange,
  onSceneChange,
  onPromptChange,
  onResetPrompt,
}: BriefPanelProps) {
  return (
    <Card
      index="02 · Contract"
      title="What must survive"
      description="Exact text the clip has to keep. Matching normalises case, accents and punctuation."
      aside={promptDirty ? <Pill tone="review">prompt edited</Pill> : <Pill tone="neutral">auto prompt</Pill>}
    >
      <div className="brief">
        <div className="brief__inputs">
          <Field
            label="Brand name"
            htmlFor="brand"
            hint="Required. Compared token by token across every readable frame."
          >
            <input
              id="brand"
              className="input"
              value={brand}
              onChange={(event) => onBrandChange(event.target.value)}
              placeholder="e.g. AURELIA"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>

          <Field
            label="Label text"
            htmlFor="label"
            hint="One line per printed line. Digits are preserved, so include volume or strength if it is printed."
            counter={`${labelText.trim().length} chars`}
          >
            <textarea
              id="label"
              className="input input--area"
              rows={4}
              value={labelText}
              onChange={(event) => onLabelChange(event.target.value)}
              placeholder={'AURELIA\nRenewal Serum\n30 ml / 1.0 fl oz'}
              spellCheck={false}
            />
          </Field>
        </div>

        <fieldset className="scenes">
          <legend className="field__label">Scene direction</legend>
          <div className="scenes__grid">
            {SCENES.map((option) => {
              const selected = option.id === scene;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`scene ${selected ? 'scene--selected' : ''}`}
                  onClick={() => onSceneChange(option.id)}
                  aria-pressed={selected}
                >
                  <span className="scene__chip" style={{ background: option.gradient }} aria-hidden="true" />
                  <span className="scene__text">
                    <span className="scene__name">{option.name}</span>
                    <span className="scene__blurb">{option.blurb}</span>
                  </span>
                  <span className="scene__check" aria-hidden="true">
                    {selected ? '●' : '○'}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <Field
          label="Video prompt"
          htmlFor="prompt"
          hint="Editable. It is sent verbatim to ComfyUI; the brand contract above is what verification measures."
          counter={`${prompt.length} chars`}
        >
          <textarea
            id="prompt"
            className="input input--area input--code"
            rows={9}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            spellCheck={false}
          />
        </Field>

        <div className="brief__footer">
          <p className="micro">
            Scene presets only compose the prompt. They do not change how the clip is verified.
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onResetPrompt}>
            Rebuild prompt
          </button>
        </div>
      </div>
    </Card>
  );
}
