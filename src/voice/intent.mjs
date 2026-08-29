const WAKE_WORDS = ['frame', 'jarvis', 'hey jarvis', 'mycroft', 'hey mycroft'];
const QUESTION_STARTERS = new Set(['what', 'whats', 'when', 'where', 'who', 'why', 'how']);

export function validateVoiceIntentRequest(body) {
  const transcript =
    typeof body?.transcript === 'string'
      ? body.transcript.trim()
      : typeof body?.text === 'string'
        ? body.text.trim()
        : '';

  if (!transcript) {
    return { error: 'Transcript is required.' };
  }

  if (transcript.length > 1000) {
    return { error: 'Transcript is too long for a photo-frame command.' };
  }

  return { value: { transcript } };
}

export function classifyVoiceIntent(transcript) {
  const normalized = removeWakeWord(normalizeVoiceText(transcript));

  if (!normalized) {
    return unknownIntent(transcript, normalized);
  }

  const target = parseTarget(normalized);

  if (isWhereQuestion(normalized)) {
    return commandIntent(transcript, normalized, 'photo-question', 'where', 'high');
  }

  if (isWhenQuestion(normalized)) {
    return commandIntent(transcript, normalized, 'photo-question', 'when', 'high');
  }

  if (isNextCommand(normalized)) {
    return commandIntent(transcript, normalized, 'navigation', 'next', 'high');
  }

  if (isPreviousCommand(normalized)) {
    return commandIntent(transcript, normalized, 'navigation', 'previous', 'high');
  }

  if (isInterestingCommand(normalized)) {
    return commandIntent(transcript, normalized, 'photo-question', commandWithTarget('interesting', target), 'high');
  }

  if (isFavoriteCommand(normalized)) {
    return commandIntent(transcript, normalized, 'photo-action', commandWithTarget('favorite', target), 'high');
  }

  if (isNeverShowCommand(normalized)) {
    return commandIntent(transcript, normalized, 'photo-action', commandWithTarget('never-show', target), 'high');
  }

  // "me" is stripped separately — an optional (?: me)? group backtracks on
  // a bare "tell me" and captures "me" as the question.
  const tellMatch = normalized.match(/^tell\s+(.+)$/);
  if (tellMatch) {
    let tellQuestion = tellMatch[1].trim();
    if (tellQuestion === 'me') {
      tellQuestion = '';
    } else if (tellQuestion.startsWith('me ')) {
      tellQuestion = tellQuestion.slice(3).trim();
    }
    if (tellQuestion) {
      return {
        kind: 'ask-question',
        command: 'tell',
        query: tellQuestion,
        confidence: 'high',
        normalized,
        transcript: String(transcript || '').trim(),
      };
    }
  }

  if (looksLikeGeneralQuestion(normalized)) {
    return {
      kind: 'general-query',
      command: null,
      query: normalized,
      confidence: 'medium',
      normalized,
      transcript: String(transcript || '').trim(),
    };
  }

  return unknownIntent(transcript, normalized);
}

export function normalizeVoiceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/what['\u2019]?s/g, 'whats')
    .replace(/don['\u2019]?t/g, 'dont')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeWakeWord(transcript) {
  for (const wakeWord of WAKE_WORDS) {
    if (transcript === wakeWord) {
      return '';
    }

    if (transcript.startsWith(`${wakeWord} `)) {
      return transcript.slice(wakeWord.length + 1);
    }
  }

  return transcript;
}

function commandIntent(transcript, normalized, category, command, confidence) {
  return {
    kind: 'app-command',
    category,
    command,
    query: null,
    confidence,
    normalized,
    transcript: String(transcript || '').trim(),
  };
}

function unknownIntent(transcript, normalized) {
  return {
    kind: 'unknown',
    command: null,
    query: normalized || null,
    confidence: 'none',
    normalized,
    transcript: String(transcript || '').trim(),
  };
}

function isWhereQuestion(value) {
  return (
    value === 'where' ||
    value === 'where is this' ||
    /^where (is|was) this( photo| picture)?( taken| from)?$/.test(value) ||
    value === 'where are we'
  );
}

function isWhenQuestion(value) {
  return (
    value === 'when' ||
    /^when (is|was) this( photo| picture)?( taken)?$/.test(value) ||
    value === 'what date was this taken' ||
    value === 'what day was this taken'
  );
}

function isNextCommand(value) {
  return (
    value === 'next' ||
    value === 'next photo' ||
    value === 'next picture' ||
    value === 'go next' ||
    value === 'go to next photo' ||
    value === 'go to the next photo' ||
    value === 'go to the next picture' ||
    value === 'show next photo' ||
    value === 'show next picture' ||
    value === 'show the next photo' ||
    value === 'show the next picture' ||
    value === 'show me the next photo' ||
    value === 'show me the next picture' ||
    value === 'show me another' ||
    value === 'skip this' ||
    value === 'advance'
  );
}

function isPreviousCommand(value) {
  return (
    value === 'last' ||
    value === 'previous' ||
    value === 'previous photo' ||
    value === 'previous picture' ||
    value === 'go back' ||
    value === 'go previous' ||
    value === 'go to previous photo' ||
    value === 'go to the previous photo' ||
    value === 'go to the previous picture' ||
    value === 'go to the last photo' ||
    value === 'go to the last picture' ||
    value === 'show previous photo' ||
    value === 'show previous picture' ||
    value === 'show the previous photo' ||
    value === 'show the previous picture' ||
    value === 'show me the previous photo' ||
    value === 'show me the previous picture' ||
    value === 'back one'
  );
}

function isInterestingCommand(value) {
  return value === 'interesting' || value === 'interesting left' || value === 'interesting right' || value === 'interesting write';
}

function isFavoriteCommand(value) {
  return (
    value === 'favorite' ||
    value === 'favorites' ||
    value.startsWith('favorite ') ||
    value.startsWith('favorites ') ||
    (value.startsWith('mark ') && value.includes('favorite')) ||
    value.endsWith(' favorite') ||
    value.endsWith(' favorites') ||
    value === 'mark this favorite' ||
    value === 'mark this as favorite' ||
    value === 'mark this as a favorite' ||
    value === 'save this photo'
  );
}

function isNeverShowCommand(value) {
  return (
    value === 'dont' ||
    value === 'don t' ||
    value === 'do not' ||
    value.startsWith('dont ') ||
    value.startsWith('don t ') ||
    value.startsWith('do not ') ||
    value.startsWith('hide ') ||
    value.startsWith('never show ') ||
    value.startsWith('remove ') ||
    value.endsWith(' dont') ||
    value.endsWith(' don t') ||
    value.endsWith(' do not') ||
    value === 'hide this' ||
    value === 'hide this photo' ||
    value === 'never show this' ||
    value === 'never show this again' ||
    value === 'never show this photo again' ||
    value === 'remove this photo from frame'
  );
}

function parseTarget(value) {
  const words = new Set(value.split(' '));

  if (words.has('left')) {
    return 'left';
  }

  if (words.has('right') || words.has('write')) {
    return 'right';
  }

  return null;
}

function commandWithTarget(command, target) {
  return target ? `${command}-${target}` : command;
}

function looksLikeGeneralQuestion(value) {
  const [firstWord] = value.split(' ');
  return QUESTION_STARTERS.has(firstWord);
}
