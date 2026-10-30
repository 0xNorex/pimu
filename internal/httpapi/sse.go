package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/0xNorex/pimu/internal/hub"
)

// handleEvents streams one session's events. Resume point: Last-Event-ID
// header (EventSource reconnect) or ?since= (seq from GET messages).
// Without either, only new events are sent.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)

	stream := s.hub.Stream(id)
	last := r.Header.Get("Last-Event-ID")
	if last == "" {
		last = r.URL.Query().Get("since")
	}
	var ch chan hub.Event
	var replay []hub.Event
	var resync bool
	if since, err := strconv.ParseUint(last, 10, 64); err == nil {
		ch, replay, resync = stream.Subscribe(since)
	} else {
		ch, _, _ = stream.Subscribe(stream.Seq())
	}
	defer stream.Unsubscribe(ch)

	// Snapshot (no id, so it does not move the client's resume point).
	state := "exited"
	holder := "none"
	if s.hub.Running(id) != nil {
		state, holder = "ready", "pimu"
	} else if s.hub.Status(id) == "external" {
		holder = "external"
	}
	writeSnap(w, map[string]any{"type": "proc_state", "state": state})
	writeSnap(w, map[string]any{"type": "lock", "holder": holder})
	if resync {
		writeSnap(w, map[string]any{"type": "resync"})
	}
	for _, ev := range replay {
		writeEvent(w, ev)
	}
	_ = rc.Flush()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
		case ev, ok := <-ch:
			if !ok {
				return // dropped as a slow consumer; client reconnects
			}
			writeEvent(w, ev)
		}
		if rc.Flush() != nil {
			return
		}
	}
}

func writeEvent(w http.ResponseWriter, ev hub.Event) {
	_, _ = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.ID, ev.Kind, ev.Data)
}

func writeSnap(w http.ResponseWriter, v any) {
	b, _ := json.Marshal(v)
	_, _ = fmt.Fprintf(w, "event: pimu\ndata: %s\n\n", b)
}
