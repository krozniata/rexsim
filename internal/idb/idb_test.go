package idb

import "testing"

func TestFrameSize(t *testing.T) {
	iphone18Pro := Screen{Width: 1206, Height: 2622, WidthPoints: 402, HeightPoints: 874}
	tests := []struct {
		name                  string
		n                     int
		scale                 float64
		width, height, stride int
	}{
		{"half scale pads rows to 64 bytes", 3188352, 0.5, 603, 1311, 2432},
		{"full scale adds two rows", 12763136, 1, 1206, 2622, 4864},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, h, stride, ok := frameSize(tt.n, iphone18Pro, tt.scale)
			if !ok || w != tt.width || h != tt.height || stride != tt.stride {
				t.Fatalf("frameSize = %d×%d stride %d ok %v, want %d×%d stride %d", w, h, stride, ok, tt.width, tt.height, tt.stride)
			}
		})
	}
}
