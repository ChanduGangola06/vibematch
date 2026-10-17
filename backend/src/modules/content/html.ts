import sanitizeHtml from 'sanitize-html';

/**
 * CMS pages are admin-authored HTML that visitors render. Even a trusted admin account can be
 * phished, so content is sanitised on write: no scripts, iframes, event handlers or javascript: URLs.
 */
export function sanitizePageHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'u', 'span', 'hr', 'figure', 'figcaption', 'small'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      '*': ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tag, attribs) => ({
        tagName: tag,
        attribs: { ...attribs, ...(attribs.target === '_blank' ? { rel: 'noopener noreferrer' } : {}) },
      }),
    },
  });
}
