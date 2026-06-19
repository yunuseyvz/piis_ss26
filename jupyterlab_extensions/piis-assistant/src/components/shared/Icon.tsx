/**
 * React icon component for FlowQuest.
 *
 * Wraps the trusted Lucide SVG strings produced by `../../icons` so they can
 * be dropped into JSX. The SVG markup is static and never contains user input,
 * so `dangerouslySetInnerHTML` is safe here.
 */

import { icon, type IconName, type IconOptions } from '../../icons';

interface IconProps extends IconOptions {
  name: IconName;
}

export function Icon({ name, ...opts }: IconProps): JSX.Element {
  return (
    <span
      className="flowquest-iconWrap"
      dangerouslySetInnerHTML={{ __html: icon(name, opts) }}
    />
  );
}
