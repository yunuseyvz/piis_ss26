/**
 * Small Flowy SVG mark for avatars, empty states, and inline decoration.
 */

import { renderFlowySvg, type FlowyMood } from '../../flowySprite';

interface FlowyMarkProps {
  mood: FlowyMood;
  size?: number;
  uid?: string;
}

export function FlowyMark({ mood, size = 58, uid }: FlowyMarkProps): JSX.Element {
  const suffix = uid ?? `fqm-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <span
      className="flowquest-flowyMark"
      dangerouslySetInnerHTML={{ __html: renderFlowySvg(mood, { uid: suffix, width: size }) }}
    />
  );
}
