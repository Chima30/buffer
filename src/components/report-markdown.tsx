"use client";

import ReactMarkdown from "react-markdown";

/**
 * Renders the agent's Markdown report. react-markdown does not render raw HTML
 * by default, so model output cannot inject markup or scripts. Links open in a
 * new tab without passing the referrer.
 */
export function ReportMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        components={{
          h1: (p) => <h1 className="mb-3 mt-1 text-xl font-semibold tracking-tight" {...p} />,
          h2: (p) => <h2 className="mb-2 mt-6 text-base font-semibold" {...p} />,
          h3: (p) => <h3 className="mb-1 mt-4 font-semibold" {...p} />,
          p: (p) => <p className="my-3 text-ink-2" {...p} />,
          ul: (p) => <ul className="my-3 list-disc space-y-1 pl-5 text-ink-2" {...p} />,
          ol: (p) => <ol className="my-3 list-decimal space-y-1 pl-5 text-ink-2" {...p} />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="break-words text-accent underline underline-offset-2">
              {children}
            </a>
          ),
          strong: (p) => <strong className="font-semibold text-ink" {...p} />,
          code: (p) => <code className="rounded bg-paper px-1 py-0.5 font-mono text-xs" {...p} />,
          blockquote: (p) => <blockquote className="my-3 border-l-2 border-rule-strong pl-3 text-ink-3" {...p} />,
          hr: () => <hr className="my-6 border-rule" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
