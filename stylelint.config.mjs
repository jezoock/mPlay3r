const kebab = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';

/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard-scss'],
  rules: {
    'selector-class-pattern': [
      `^(?:${kebab}(?:__${kebab})?)?(?:--${kebab})?$`,
      {
        resolveNestedSelectors: true,
        message: selector => `Expected class "${selector}" to follow mp-/ds- BEM or --modifier kebab-case`,
      },
    ],
    'custom-property-pattern': [
      `^(?:mp|ds)-${kebab}$`,
      { message: name => `Expected custom property "${name}" to start with --mp- or --ds- in kebab-case` },
    ],
    'rule-empty-line-before': ['always-multi-line', { except: ['first-nested'], ignore: ['after-comment', 'inside-block'] }],
    'at-rule-empty-line-before': [
      'always',
      { except: ['first-nested'], ignore: ['after-comment', 'blockless-after-blockless', 'inside-block'], ignoreAtRules: ['else'] },
    ],
    'declaration-empty-line-before': null,
    'custom-property-empty-line-before': null,
    'scss/double-slash-comment-empty-line-before': null,
    'scss/dollar-variable-empty-line-before': null,
    'scss/comment-no-empty': null,
    'scss/at-if-no-null': null,
    'scss/at-mixin-argumentless-call-parentheses': 'always',
    'color-hex-length': 'long',
    'value-keyword-case': ['lower', { camelCaseSvgKeywords: true, ignoreProperties: ['/^\\$font-family-/'] }],
    'selector-not-notation': null,
    'property-no-vendor-prefix': [true, { ignoreProperties: ['-webkit-user-select', '/^-webkit-mask-/'] }],
  },
};
