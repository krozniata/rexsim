package view

import (
	"hash/crc32"
	"os"
	"testing"
)

func benchFrame(b *testing.B, w, h int) {
	stride := (w*4 + 63) / 64 * 64
	bgra := make([]byte, stride*h)
	r := int(screenRadius(float64(w)/float64(h)) * float64(w))
	mask := cornerMask(r)
	var rgba []byte
	b.Run("crc", func(b *testing.B) {
		for b.Loop() {
			crc32.Checksum(bgra, castagnoli)
		}
	})
	b.Run("toRGBA", func(b *testing.B) {
		for b.Loop() {
			rgba = toRGBA(bgra, w, h, stride, mask, r)
		}
	})
	b.Run("tempfile", func(b *testing.B) {
		for b.Loop() {
			f, _ := os.CreateTemp("", "rexsim-bench-*")
			f.Write(rgba)
			f.Close()
			os.Remove(f.Name())
		}
	})
}

func BenchmarkFrameHalf(b *testing.B) { benchFrame(b, 603, 1311) }
func BenchmarkFrameFull(b *testing.B) { benchFrame(b, 1206, 2622) }
