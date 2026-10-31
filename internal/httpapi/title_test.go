package httpapi

import "testing"

func TestAutoTitle(t *testing.T) {
	for in, want := range map[string]string{
		"帮我整理一下本周的读书笔记，按主题分类": "整理一下本周的读书笔记",
		"你好！": "新 Bot",
		"请帮我看看 https://x.y/z 这个页面在讲什么？": "看看 这个页面在讲什么",
		"/skill:foo": "新 Bot",
		"can you write a haiku about autumn rain in kyoto": "Write a haiku about autumn",
		"把这份很长很长很长很长很长的会议纪要整理成三条结论":                        "把这份很长很长很长很长很长的",
		"Fix the build": "Fix the build",
	} {
		if got := autoTitle(in); got != want {
			t.Errorf("autoTitle(%q) = %q, want %q", in, got, want)
		}
	}
}
