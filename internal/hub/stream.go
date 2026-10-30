package hub

import "sync"

const ringSize = 5000

// Event is one SSE record. Kind is "pi" (raw pi stdout line) or "pimu".
type Event struct {
	ID   uint64
	Kind string
	Data []byte
}

// Stream is a per-session event log with a bounded in-memory replay buffer.
type Stream struct {
	mu   sync.Mutex
	seq  uint64
	ring []Event
	subs map[chan Event]struct{}
}

func newStream() *Stream { return &Stream{subs: map[chan Event]struct{}{}} }

func (s *Stream) Seq() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seq
}

func (s *Stream) publish(kind string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	ev := Event{ID: s.seq, Kind: kind, Data: data}
	s.ring = append(s.ring, ev)
	if len(s.ring) > ringSize+ringSize/4 { // trim in batches, not on every event
		s.ring = append(s.ring[:0:0], s.ring[len(s.ring)-ringSize:]...)
	}
	for ch := range s.subs {
		select {
		case ch <- ev:
		default: // slow client: drop it; EventSource reconnects with Last-Event-ID
			delete(s.subs, ch)
			close(ch)
		}
	}
}

// Subscribe returns a live channel plus buffered events after since.
// resync is true when since is outside the buffer (client must refetch).
func (s *Stream) Subscribe(since uint64) (ch chan Event, replay []Event, resync bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch = make(chan Event, 512)
	s.subs[ch] = struct{}{}
	if since > s.seq {
		return ch, nil, true
	}
	if since < s.seq {
		if len(s.ring) == 0 || s.ring[0].ID > since+1 {
			return ch, nil, true
		}
		for _, ev := range s.ring {
			if ev.ID > since {
				replay = append(replay, ev)
			}
		}
	}
	return ch, replay, false
}

func (s *Stream) Unsubscribe(ch chan Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[ch]; ok {
		delete(s.subs, ch)
		close(ch)
	}
}
