package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ambientsound/rex/pkg/library"
	"github.com/ambientsound/rex/pkg/mediascanner"
	"github.com/ambientsound/rex/pkg/rekordbox/color"
	"github.com/ambientsound/rex/pkg/rekordbox/column"
	"github.com/ambientsound/rex/pkg/rekordbox/dbengine"
	"github.com/ambientsound/rex/pkg/rekordbox/page"
	"github.com/ambientsound/rex/pkg/rekordbox/pdb"
	"github.com/ambientsound/rex/pkg/rekordbox/playlist"
	"github.com/ambientsound/rex/pkg/rekordbox/unknown17"
	"github.com/ambientsound/rex/pkg/rekordbox/unknown18"
)

type InputTrack struct {
	ID          int     `json:"id"`
	Title       string  `json:"title"`
	Artist      string  `json:"artist"`
	Album       string  `json:"album"`
	Duration    float64 `json:"duration"`
	BPM         float64 `json:"bpm"`
	KeyRaw      string  `json:"key_raw"`
	FilePath    string  `json:"file_path"`
	TrackNumber int     `json:"track_number"`
	Year        string  `json:"year"`
	Label       string  `json:"label"`
	Genres      []string `json:"genres"`
	FileSize    int     `json:"file_size"`
	Bitrate     int     `json:"bitrate"`
	Comments    string  `json:"comments"`
}

type InputPlaylist struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	TrackIDs []int  `json:"track_ids"`
}

type Input struct {
	USBRoot   string          `json:"usbRoot"`
	Tracks    []InputTrack    `json:"tracks"`
	Playlists []InputPlaylist `json:"playlists"`
}

func parseYear(year string) *time.Time {
	if len(year) == 0 {
		return nil
	}
	t, err := time.Parse("2006", year)
	if err != nil {
		return nil
	}
	return &t
}

func detectFileType(path string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	if ext == "" {
		return "mp3"
	}
	return ext
}

func main() {
	var input Input
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fmt.Fprintf(os.Stderr, "error reading input: %v\n", err)
		os.Exit(1)
	}

	if input.USBRoot == "" {
		fmt.Fprintf(os.Stderr, "usbRoot is required\n")
		os.Exit(1)
	}

	usbRoot, err := filepath.Abs(input.USBRoot)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid usbRoot: %v\n", err)
		os.Exit(1)
	}

	outputPath := filepath.Join(usbRoot, "PIONEER", "rekordbox")
	if err := os.MkdirAll(outputPath, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "error creating output directory: %v\n", err)
		os.Exit(1)
	}

	outputFile := filepath.Join(outputPath, "export.pdb")
	fmt.Printf("Writing PDB to: %s\n", outputFile)

	out, err := os.OpenFile(outputFile, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error opening output file: %v\n", err)
		os.Exit(1)
	}
	defer out.Close()

	lib := library.New()
	now := time.Now()

	// Map from JSON track ID to library track pointer
	trackByID := make(map[int]*library.Track, len(input.Tracks))

	fmt.Printf("Adding %d tracks\n", len(input.Tracks))
	for i := range input.Tracks {
		t := &input.Tracks[i]
		duration := time.Duration(t.Duration * float64(time.Second))

		addedDate := &now
		releaseDate := parseYear(t.Year)

		bitrate := t.Bitrate
		if bitrate == 0 {
			bitrate = 320
		}

		genre := ""
		if len(t.Genres) > 0 {
			genre = strings.Join(t.Genres, ", ")
		}
		_ = genre // stored in comment below for now; rex Track has no Genre field

		libTrack := &library.Track{
			Path:        t.FilePath,
			OutputPath:  t.FilePath,
			Title:       t.Title,
			Artist:      t.Artist,
			Album:       t.Album,
			Duration:    duration,
			Tempo:       t.BPM,
			TrackNumber: t.TrackNumber,
			FileSize:    t.FileSize,
			Bitrate:     bitrate,
			SampleDepth: 16,
			SampleRate:  44100,
			DiscNumber:  0,
			Isrc:        "",
			ReleaseDate: releaseDate,
			AddedDate:   addedDate,
			FileType:    detectFileType(t.FilePath),
		}

		lib.InsertTrack(libTrack)
		trackByID[t.ID] = libTrack
	}

	// Register artists and albums so IDs are consistent
	for _, t := range lib.Tracks().All() {
		lib.Artist(t.Artist)
		lib.Album(t.Album)
	}

	type Insert struct {
		Type page.Type
		Row  page.Row
	}
	inserts := make([]Insert, 0)

	// Tracks
	fmt.Printf("Building track records\n")
	for _, t := range lib.Tracks().All() {
		pdbTrack := mediascanner.PdbTrack(lib, t, "")
		pdbTrack.FilePath = t.OutputPath
		pdbTrack.Filename = filepath.Base(t.Path)
		inserts = append(inserts, Insert{Type: page.Type_Tracks, Row: &pdbTrack})
	}

	// Artists
	for _, a := range lib.Artists().All() {
		pdbArtist := mediascanner.PdbArtist(lib, a)
		inserts = append(inserts, Insert{Type: page.Type_Artists, Row: &pdbArtist})
	}

	// Albums
	for _, a := range lib.Albums().All() {
		pdbAlbum := mediascanner.PdbAlbum(lib, a)
		inserts = append(inserts, Insert{Type: page.Type_Albums, Row: &pdbAlbum})
	}

	// Playlists
	fmt.Printf("Building %d playlists\n", len(input.Playlists))
	for i, pl := range input.Playlists {
		plID := uint32(i + 1)
		plRow := &playlist.Playlist{
			PlaylistHeader: playlist.PlaylistHeader{
				ParentId:    0,
				Unknown1:    0,
				SortOrder:   uint32(i),
				Id:          plID,
				RawIsFolder: 0,
			},
			Name: pl.Name,
		}
		inserts = append(inserts, Insert{Type: page.Type_PlaylistTree, Row: plRow})

		for entryIdx, trackID := range pl.TrackIDs {
			libTrack, ok := trackByID[trackID]
			if !ok {
				continue
			}
			rexID := uint32(lib.Tracks().ID(libTrack))
			entry := &playlist.Entry{
				EntryIndex: uint32(entryIdx + 1),
				TrackID:    rexID,
				PlaylistID: plID,
			}
			inserts = append(inserts, Insert{Type: page.Type_PlaylistEntries, Row: entry})
		}
	}

	// Required static datasets
	for _, uk := range unknown17.InitialDataset {
		inserts = append(inserts, Insert{Type: page.Type_Unknown17, Row: uk})
	}
	for _, uk := range unknown18.InitialDataset {
		inserts = append(inserts, Insert{Type: page.Type_Unknown18, Row: uk})
	}
	for _, uk := range color.InitialDataset {
		inserts = append(inserts, Insert{Type: page.Type_Colors, Row: uk})
	}
	for _, uk := range column.InitialDataset {
		inserts = append(inserts, Insert{Type: page.Type_Columns, Row: uk})
	}

	// Initialize and populate the database
	db := dbengine.New(out)

	for _, pageType := range pdb.TableOrder {
		if err := db.CreateTable(pageType); err != nil {
			fmt.Fprintf(os.Stderr, "error creating table: %v\n", err)
			os.Exit(1)
		}
	}

	dataPages := make(map[page.Type]*page.Data)
	for _, ins := range inserts {
		if dataPages[ins.Type] == nil {
			dataPages[ins.Type] = page.NewPage(ins.Type)
		}
		err := dataPages[ins.Type].Insert(ins.Row)
		if err == nil {
			continue
		}
		if err == io.ErrShortWrite {
			if err2 := db.InsertPage(dataPages[ins.Type]); err2 != nil {
				fmt.Fprintf(os.Stderr, "error inserting page: %v\n", err2)
				os.Exit(1)
			}
			dataPages[ins.Type] = page.NewPage(ins.Type)
			if err2 := dataPages[ins.Type].Insert(ins.Row); err2 != nil {
				fmt.Fprintf(os.Stderr, "error inserting row after page flush: %v\n", err2)
				os.Exit(1)
			}
			continue
		}
		fmt.Fprintf(os.Stderr, "error inserting row: %v\n", err)
		os.Exit(1)
	}

	for _, pg := range dataPages {
		if pg == nil {
			continue
		}
		if err := db.InsertPage(pg); err != nil {
			fmt.Fprintf(os.Stderr, "error inserting final page: %v\n", err)
			os.Exit(1)
		}
	}

	if err := out.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "error closing output file: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Done")
}
