package term

import (
	"reflect"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		in   string
		want any
		n    int
	}{
		{"\x1b[<0;650;300M", Mouse{Button: 0, X: 649, Y: 299}, 13},
		{"\x1b[<32;700;300M", Mouse{Button: 0, X: 699, Y: 299, Motion: true}, 14},
		{"\x1b[<0;700;300m", Mouse{Button: 0, X: 699, Y: 299, Release: true}, 13},
		{"\x1b[<65;10;20M", Mouse{Button: 65, X: 9, Y: 19}, 12},
		{"\x1b[200~hi there\x1b[201~", Paste{Text: "hi there"}, 20},
		{"\x1b[A", Key{Name: "up"}, 3},
		{"\x02", Key{Name: "ctrl+b"}, 1},
		{"\x1d", Key{Name: "ctrl+]"}, 1},
		{"\r", Key{Name: "enter"}, 1},
		{"ż", Key{Rune: 'ż'}, 2},
		{"\x1b", nil, 0},
		{"\x1b[<0;65", nil, 0},
		{"\x1b[200~unfinished", nil, 0},
	}
	for _, tt := range tests {
		got, n := parse([]byte(tt.in))
		if n != tt.n || !reflect.DeepEqual(got, tt.want) {
			t.Errorf("parse(%q) = %#v, %d; want %#v, %d", tt.in, got, n, tt.want, tt.n)
		}
	}
}
