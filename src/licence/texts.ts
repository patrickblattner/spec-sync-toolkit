/**
 * Recognises a licence file by the distinctive phrases of the common SPDX
 * licence texts (SST-FEATURE-001). Deliberately small: a text it does not
 * recognise is `undefined`, which the inventory reports as "unreadable" —
 * fail-closed, never a guess.
 */

/** Lower case, every run of non-alphanumerics collapsed to one space. */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface Matcher {
  id: string;
  all: string[];
  none?: string[];
}

/** Checked in order: the more specific texts come before the generic ones. */
const MATCHERS: Matcher[] = [
  { id: "Apache-2.0", all: ["apache license", "version 2 0"] },
  { id: "MPL-2.0", all: ["mozilla public license version 2 0"] },
  { id: "BlueOak-1.0.0", all: ["blue oak model license"] },
  { id: "CC0-1.0", all: ["cc0 1 0"] },
  { id: "CC-BY-4.0", all: ["creative commons", "attribution 4 0 international"] },
  {
    id: "Unlicense",
    all: ["this is free and unencumbered software released into the public domain"],
  },
  { id: "Python-2.0", all: ["python software foundation license version 2"] },
  {
    id: "BSD-3-Clause",
    all: [
      "redistribution and use in source and binary forms with or without modification are permitted",
      "endorse or promote products derived from this software",
    ],
  },
  {
    id: "BSD-2-Clause",
    all: [
      "redistribution and use in source and binary forms with or without modification are permitted",
    ],
  },
  {
    id: "MIT",
    all: [
      "permission is hereby granted free of charge to any person obtaining a copy",
      "the above copyright notice and this permission notice shall be included",
    ],
  },
  {
    id: "ISC",
    all: [
      "permission to use copy modify and or distribute this software for any purpose with or without fee is hereby granted",
      "provided that the above copyright notice and this permission notice appear in all copies",
    ],
  },
  {
    id: "0BSD",
    all: [
      "permission to use copy modify and or distribute this software for any purpose with or without fee is hereby granted",
    ],
    none: ["provided that the above copyright notice"],
  },
];

/** The SPDX id of a licence text, or `undefined` when it matches none. */
export function matchLicenceText(text: string): string | undefined {
  const normalised = normaliseText(text);
  for (const matcher of MATCHERS) {
    if (!matcher.all.every((phrase) => normalised.includes(phrase))) continue;
    if (matcher.none?.some((phrase) => normalised.includes(phrase))) continue;
    return matcher.id;
  }
  return undefined;
}
