package httpapi

import (
	"log/slog"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// nameDraft names a draft bot (no name yet) after its first message, before
// pi starts, so pi gets --name too. Best effort: a failure leaves the draft.
func (s *Server) nameDraft(id, msg string) {
	b, err := s.st.Bot(id)
	if err != nil || b.Name != "" {
		return
	}
	b.Name = autoTitle(msg)
	if _, err := s.st.UpdateBot(b); err != nil {
		slog.Warn("name new bot", "session", id, "err", err)
	}
}

var (
	urlRe    = regexp.MustCompile(`https?://\S+`)
	politeRe = regexp.MustCompile(`(?i)^(请你|请|麻烦你|麻烦|帮我|帮忙|你好|您好|能不能|能否|可不可以|可以|我想要|我想|我要|hi|hello|hey|please|can you|could you|would you)[\s,，、:：!！]*`)
	stopRe   = regexp.MustCompile(`[。！？!?；;\n]`)
)

// autoTitle turns a first message into a short bot name with no model call:
// first sentence, polite openers dropped, cut at a comma when that still
// leaves a phrase, at most 14 CJK characters or 5 words.
func autoTitle(msg string) string {
	t := strings.Join(strings.Fields(strings.SplitN(urlRe.ReplaceAllString(msg, " "), "\n", 2)[0]), " ")
	if strings.HasPrefix(t, "/") {
		t = ""
	}
	if i := stopRe.FindStringIndex(t); i != nil {
		t = t[:i[0]]
	}
	for {
		n := politeRe.ReplaceAllString(t, "")
		if n == t {
			break
		}
		t = strings.TrimSpace(n)
	}
	if i := strings.IndexAny(t, ",，、:："); i > 0 && utf8.RuneCountInString(t[:i]) >= 4 {
		t = t[:i]
	}
	t = strings.TrimFunc(t, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) })
	if w := strings.Fields(t); len(w) > 5 && !hasCJK(t) {
		t = strings.Join(w[:5], " ")
	}
	if r := []rune(t); len(r) > 14 && hasCJK(t) {
		t = string(r[:14])
	} else if len(r) > 32 {
		t = string(r[:32])
	}
	if t == "" {
		return "新 Bot"
	}
	r, n := utf8.DecodeRuneInString(t)
	return string(unicode.ToUpper(r)) + t[n:]
}

func hasCJK(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}
