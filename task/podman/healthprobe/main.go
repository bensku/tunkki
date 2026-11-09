// Command healthprobe checks that an HTTP server inside a container is
// healthy. podman.containerv2 mounts it into containers and runs it as their
// health check, since Podman only supports command health checks and many
// images have neither curl nor wget.
//
// Usage: healthprobe <port> [path]
//
// Sends GET <path> to 127.0.0.1:<port>, or to [::1]:<port> if nothing listens
// on IPv4. Exits with 0 if the response status is 2xx or 3xx, 1 otherwise.
//
// It must stay statically linked, because containers may lack libc entirely.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Podman kills health checks that exceed their timeout anyway, this is just
// a fallback in case it is not configured.
const timeout = 30 * time.Second

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "healthprobe:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("usage: healthprobe <port> [path]")
	}
	port, err := strconv.ParseUint(args[0], 10, 16)
	if err != nil || port == 0 {
		return fmt.Errorf("invalid port %q", args[0])
	}
	path := "/"
	if len(args) == 2 {
		path = args[1]
	}
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, " \r\n") {
		return fmt.Errorf("invalid path %q", path)
	}

	deadline := time.Now().Add(timeout)
	conn, err := dial(port, deadline)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}

	request := "GET " + path + " HTTP/1.1\r\n" +
		"Host: localhost:" + args[0] + "\r\n" +
		"User-Agent: tunkki-healthprobe\r\n" +
		"Connection: close\r\n\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		return err
	}

	// Only the status line matters
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}
	line = strings.TrimRight(line, "\r\n")
	fields := strings.SplitN(line, " ", 3)
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
		return fmt.Errorf("invalid status line %q", line)
	}
	status, err := strconv.Atoi(fields[1])
	if err != nil {
		return fmt.Errorf("invalid status line %q", line)
	}
	if status < 200 || status >= 400 {
		return fmt.Errorf("GET %s: %s", path, strings.Join(fields[1:], " "))
	}
	fmt.Printf("GET %s: %s\n", path, strings.Join(fields[1:], " "))
	return nil
}

func dial(port uint64, deadline time.Time) (net.Conn, error) {
	dialer := net.Dialer{Deadline: deadline}
	p := strconv.FormatUint(port, 10)
	conn, err := dialer.Dial("tcp", net.JoinHostPort("127.0.0.1", p))
	if errors.Is(err, syscall.ECONNREFUSED) {
		// Some servers listen only on IPv6
		if conn6, err6 := dialer.Dial("tcp", net.JoinHostPort("::1", p)); err6 == nil {
			return conn6, nil
		}
	}
	return conn, err
}
