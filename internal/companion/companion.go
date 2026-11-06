// Package companion installs and runs Meta's idb_companion, which reads the
// simulator's framebuffer and injects HID events through CoreSimulator.
package companion

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	version       = "1.7.8"
	archiveURL    = "https://github.com/facebook/idb/releases/download/v" + version + "/idb-companion.macos-arm64.tar.gz"
	archiveSHA256 = "44369a2df0b62e3a1764de61bd09280999c7e9b27ea8f20bff1ea3a9db0302a2"
)

func CacheDir() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "rexsim"), nil
}

// Binary returns the path of idb_companion. It downloads the pinned release
// on first use. REXSIM_COMPANION points at another build.
func Binary(ctx context.Context, progress func(string)) (string, error) {
	if p := os.Getenv("REXSIM_COMPANION"); p != "" {
		return p, nil
	}
	root, err := CacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "idb-companion-"+version)
	bin := filepath.Join(dir, "idb_companion")
	if fi, err := os.Stat(bin); err == nil && fi.Mode()&0o111 != 0 {
		return bin, nil
	}
	progress("downloading idb_companion " + version + "…")
	data, err := download(ctx, archiveURL)
	if err != nil {
		return "", err
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != archiveSHA256 {
		return "", fmt.Errorf("idb_companion download has the wrong checksum")
	}
	partial := fmt.Sprintf("%s.partial-%d", dir, os.Getpid())
	_ = os.RemoveAll(partial)
	if err := extract(data, partial); err != nil {
		_ = os.RemoveAll(partial)
		return "", err
	}
	if err := os.Rename(partial, dir); err != nil {
		_ = os.RemoveAll(partial)
		return "", err
	}
	return bin, nil
}

func download(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: %s", url, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 512<<20))
}

func extract(data []byte, dest string) error {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(h.Name)
		if name == "." {
			continue
		}
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
			return fmt.Errorf("archive entry %q leaves the destination", h.Name)
		}
		path := filepath.Join(dest, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o755|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			target := filepath.Join(filepath.Dir(name), h.Linkname)
			if filepath.IsAbs(h.Linkname) || strings.HasPrefix(filepath.Clean(target), "..") {
				return fmt.Errorf("archive link %q leaves the destination", h.Name)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(h.Linkname, path); err != nil {
				return err
			}
		}
	}
}

type Companion struct {
	Socket string
	cmd    *exec.Cmd
	exited chan struct{}
}

// Start runs a companion for one simulator on a private Unix socket. The
// socket lives in /tmp, not $TMPDIR, because a socket path must fit in 104
// bytes. A TCP port would listen on every interface without authentication.
func Start(ctx context.Context, bin, udid string) (*Companion, error) {
	dir, err := SocketDir()
	if err != nil {
		return nil, err
	}
	short := udid[:min(8, len(udid))]
	sock := filepath.Join(dir, fmt.Sprintf("%d-%s.sock", os.Getpid(), short))
	_ = os.Remove(sock)

	root, err := CacheDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	logPath := filepath.Join(root, "companion-"+short+".log")
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	defer log.Close()

	cmd := exec.Command(bin, "--udid", udid, "--grpc-domain-sock", sock)
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &Companion{Socket: sock, cmd: cmd, exited: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(c.exited) }()

	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(sock); err == nil {
			return c, nil
		}
		select {
		case <-ctx.Done():
			c.Close()
			return nil, ctx.Err()
		case <-c.exited:
			return nil, fmt.Errorf("idb_companion exited; see %s", logPath)
		case <-deadline.C:
			c.Close()
			return nil, fmt.Errorf("idb_companion did not start; see %s", logPath)
		case <-tick.C:
		}
	}
}

// SocketDir returns rexsim's private directory for Unix sockets, creating it
// with mode 0700.
func SocketDir() (string, error) {
	dir := fmt.Sprintf("/tmp/rexsim-%d", os.Getuid())
	return dir, privateDir(dir)
}

func privateDir(dir string) error {
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.IsDir() || !ok || int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s is not a directory owned by you", dir)
	}
	return os.Chmod(dir, 0o700)
}

func (c *Companion) Close() {
	select {
	case <-c.exited:
	default:
		_ = c.cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-c.exited:
		case <-time.After(2 * time.Second):
			_ = c.cmd.Process.Kill()
			<-c.exited
		}
	}
	_ = os.Remove(c.Socket)
}
