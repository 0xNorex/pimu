// Package notify sends outbound Telegram messages via the Bot API.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// APIBase is the Bot API root; a var only so a local listener can stand in for it.
var APIBase = "https://api.telegram.org"

type Telegram struct {
	Token  string
	ChatID string
}

func (t Telegram) Enabled() bool { return t.Token != "" && t.ChatID != "" }

// Request builds the sendMessage call (plain text, no parse_mode, so task
// output never breaks Markdown parsing).
func (t Telegram) Request(ctx context.Context, text string) (*http.Request, error) {
	body, _ := json.Marshal(map[string]any{"chat_id": t.ChatID, "text": text, "disable_web_page_preview": true})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, APIBase+"/bot"+t.Token+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("telegram: bad request")
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

// Send posts text. Errors never contain the token (it is part of the URL).
func (t Telegram) Send(ctx context.Context, text string) error {
	req, err := t.Request(ctx, text)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return fmt.Errorf("telegram: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out)
	if !out.OK {
		return fmt.Errorf("telegram: HTTP %d: %s", resp.StatusCode, out.Description)
	}
	return nil
}
