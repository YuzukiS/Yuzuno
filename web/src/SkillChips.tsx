import { pathTail } from "./skill-refs";
import type { SkillRef } from "./types";
import { strings, useStrings } from "./i18n";
import "./skill-chips.css";

// The chips' own words (T-189); skill names, scopes and paths as listed.
const text = strings({
  label: "Codex skills",
  kind: "Skill",
  remove: (name: string) => `Remove skill ${name}`,
}, {
  label: "Codex 技能",
  kind: "技能",
  remove: (name) => `移除技能 ${name}`,
});

/**
 * Codex skills (T-29): those chosen for a draft, removable, which Send
 * invokes; or those a message invoked. A skill is its name and its path on
 * the Agent's machine, so two of one name show where each is.
 */
export function SkillChips({ skills, onRemove }: {
  skills: readonly (SkillRef & { scope?: string })[];
  onRemove?: (skill: SkillRef) => void;
}) {
  const t = useStrings(text);
  if (!skills.length) return null;
  return (
    <ul className="skill-chips" aria-label={t.label}>
      {skills.map((skill) => {
        const where = [skill.scope, pathTail(skill.path)].filter(Boolean).join(" · ");
        return (
          <li key={`${skill.name}\n${skill.path}`} className="skill-chip" title={skill.path}>
            <span className="skill-chip-kind">{t.kind}</span>
            <span className="skill-chip-name">${skill.name}</span>
            {where && <small className="skill-chip-where">{where}</small>}
            {onRemove && (
              <button type="button" className="skill-chip-remove" aria-label={t.remove(skill.name)} onClick={() => onRemove(skill)}>
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
