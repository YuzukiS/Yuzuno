import { pathTail } from "./skill-refs";
import type { SkillRef } from "./types";
import "./skill-chips.css";

/**
 * Codex skills (T-29): those chosen for a draft, removable, which Send
 * invokes; or those a message invoked. A skill is its name and its path on
 * the Agent's machine, so two of one name show where each is.
 */
export function SkillChips({ skills, onRemove }: {
  skills: readonly (SkillRef & { scope?: string })[];
  onRemove?: (skill: SkillRef) => void;
}) {
  if (!skills.length) return null;
  return (
    <ul className="skill-chips" aria-label="Codex skills">
      {skills.map((skill) => {
        const where = [skill.scope, pathTail(skill.path)].filter(Boolean).join(" · ");
        return (
          <li key={`${skill.name}\n${skill.path}`} className="skill-chip" title={skill.path}>
            <span className="skill-chip-kind">Skill</span>
            <span className="skill-chip-name">${skill.name}</span>
            {where && <small className="skill-chip-where">{where}</small>}
            {onRemove && (
              <button type="button" className="skill-chip-remove" aria-label={`Remove skill ${skill.name}`} onClick={() => onRemove(skill)}>
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
