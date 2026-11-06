import { Highlight, type PrismTheme } from 'prism-react-renderer';
import type { ReactNode } from 'react';

/** Colors come from CSS variables, so the code follows the light/dark theme. */
const theme: PrismTheme = {
  plain: { color: 'var(--code-fg)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment'], style: { color: 'var(--code-comment)', fontStyle: 'italic' } },
    { types: ['keyword', 'module', 'control-flow'], style: { color: 'var(--code-keyword)' } },
    { types: ['string', 'template-string'], style: { color: 'var(--code-string)' } },
    { types: ['number', 'boolean'], style: { color: 'var(--code-number)' } },
    { types: ['function', 'method'], style: { color: 'var(--code-fn)' } },
    { types: ['property', 'property-access'], style: { color: 'var(--code-prop)' } },
    { types: ['punctuation', 'operator'], style: { color: 'var(--code-punct)' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: 'var(--code-type)' } },
  ],
};

export function CodePane({
  title,
  meta,
  code,
  language,
  hot,
  live,
  onHoverLine,
  wrap,
}: {
  title: ReactNode;
  meta?: ReactNode;
  code: string;
  language: 'tsx' | 'json';
  /** Lines to emphasize (hovered flow node). */
  hot?: Set<number>;
  /** Lines of the step running now. */
  live?: Set<number>;
  onHoverLine?: (line: number | undefined) => void;
  wrap?: boolean;
}) {
  return (
    <div className={`code-pane ${wrap ? 'wrap' : ''}`}>
      <div className="code-h">
        <span className="code-title">{title}</span>
        {meta && <span className="code-meta">{meta}</span>}
      </div>
      <Highlight code={code.replace(/\n$/, '')} language={language} theme={theme}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="code" onMouseLeave={() => onHoverLine?.(undefined)}>
            {tokens.map((line, i) => {
              const props = getLineProps({ line });
              const cls = [
                props.className,
                'code-line',
                hot?.has(i) ? 'is-hot' : '',
                live?.has(i) ? 'is-live' : '',
              ].join(' ');
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors highlights; nothing is actionable
                <div key={i} {...props} className={cls} onMouseEnter={() => onHoverLine?.(i)}>
                  <span className="ln">{i + 1}</span>
                  <span className="lc">
                    {line.map((token, k) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                      <span key={k} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
