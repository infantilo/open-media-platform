// Package is04 baut minimale, gültige IS-04-v1.3-Resources (Node, Device,
// Sender, Receiver) und registriert sie bei einer NMOS-Registry. Feldnamen
// und Pflichtfelder geprüft gegen AMWA-TV/is-04 (Branch v1.3.x,
// APIs/schemas/{resource_core,node,device,sender,receiver_core,
// receiver_video}.json) — siehe docs/decisions.md, Arbeitsregel §0.6.
package is04

import (
	"fmt"
	"time"
)

// Node ist die minimale Teilmenge eines IS-04-v1.3-Node-Resource, die für
// die Registrierung eines Mock-Nodes benötigt wird.
type Node struct {
	ID          string              `json:"id"`
	Version     string              `json:"version"`
	Label       string              `json:"label"`
	Description string              `json:"description"`
	Tags        map[string][]string `json:"tags"`
	Href        string              `json:"href"`
	Caps        map[string]any      `json:"caps"`
	API         NodeAPI             `json:"api"`
	Services    []any               `json:"services"`
	Clocks      []any               `json:"clocks"`
	Interfaces  []NodeInterface     `json:"interfaces"`
}

type NodeAPI struct {
	Versions  []string       `json:"versions"`
	Endpoints []NodeEndpoint `json:"endpoints"`
}

type NodeEndpoint struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

type NodeInterface struct {
	ChassisID *string `json:"chassis_id"`
	PortID    string  `json:"port_id"`
	Name      string  `json:"name"`
}

// Device ist die minimale Teilmenge eines IS-04-v1.3-Device-Resource.
type Device struct {
	ID          string              `json:"id"`
	Version     string              `json:"version"`
	Label       string              `json:"label"`
	Description string              `json:"description"`
	Tags        map[string][]string `json:"tags"`
	Type        string              `json:"type"`
	NodeID      string              `json:"node_id"`
	Senders     []string            `json:"senders"`
	Receivers   []string            `json:"receivers"`
	Controls    []any               `json:"controls"`
}

// Sender ist die minimale Teilmenge eines IS-04-v1.3-Sender-Resource. Der
// Mock-Node routet keinen echten Flow, daher FlowID immer nil.
type Sender struct {
	ID                string              `json:"id"`
	Version           string              `json:"version"`
	Label             string              `json:"label"`
	Description       string              `json:"description"`
	Tags              map[string][]string `json:"tags"`
	FlowID            *string             `json:"flow_id"`
	Transport         string              `json:"transport"`
	DeviceID          string              `json:"device_id"`
	ManifestHref      *string             `json:"manifest_href"`
	InterfaceBindings []string            `json:"interface_bindings"`
	Subscription      SenderSubscription  `json:"subscription"`
}

type SenderSubscription struct {
	ReceiverID *string `json:"receiver_id"`
	Active     bool    `json:"active"`
}

// Receiver ist die minimale Teilmenge eines IS-04-v1.3-Video-Receiver-
// Resource (receiver_video.json: zusätzlich zu receiver_core "format" und
// "caps" erforderlich).
type Receiver struct {
	ID                string               `json:"id"`
	Version           string               `json:"version"`
	Label             string               `json:"label"`
	Description       string               `json:"description"`
	Tags              map[string][]string  `json:"tags"`
	DeviceID          string               `json:"device_id"`
	Transport         string               `json:"transport"`
	InterfaceBindings []string             `json:"interface_bindings"`
	Subscription      ReceiverSubscription `json:"subscription"`
	Format            string               `json:"format"`
	Caps              ReceiverCaps         `json:"caps"`
}

type ReceiverSubscription struct {
	SenderID *string `json:"sender_id"`
	Active   bool    `json:"active"`
}

type ReceiverCaps struct {
	MediaTypes []string `json:"media_types"`
}

const (
	interfaceName = "eth0"
	transportRTP  = "urn:x-nmos:transport:rtp"
	formatVideo   = "urn:x-nmos:format:video"
)

// nowVersion liefert einen für das "version"-Feld gültigen Wert
// (Pattern "^[0-9]+:[0-9]+$"); eine exakte TAI-Zeit ist für den Mock-Node
// nicht nötig (siehe docs/decisions.md, gleiche Begründung wie A5).
func nowVersion() string {
	now := time.Now()
	return fmt.Sprintf("%d:%d", now.Unix(), now.Nanosecond())
}

// NewNode baut ein minimales, gültiges Node-Resource für host:port.
// protocol ist "http" oder "https" (UMSETZUNG.md D3: "https", wenn der
// Node mTLS-Server-TLS aktiviert hat — der Orchestrator-Proxy liest das
// Schema aus diesem href, kein separates mTLS-Flag im Node-Resource
// nötig).
func NewNode(id, label, host string, port int, protocol string) Node {
	mac := fmt.Sprintf("00-00-00-00-%02x-01", port&0xff)
	return Node{
		ID:          id,
		Version:     nowVersion(),
		Label:       label,
		Description: "",
		Tags:        map[string][]string{},
		Href:        fmt.Sprintf("%s://%s:%d/", protocol, host, port),
		Caps:        map[string]any{},
		API: NodeAPI{
			Versions:  []string{"v1.3"},
			Endpoints: []NodeEndpoint{{Host: host, Port: port, Protocol: protocol}},
		},
		Services: []any{},
		Clocks:   []any{},
		Interfaces: []NodeInterface{
			{ChassisID: nil, PortID: mac, Name: interfaceName},
		},
	}
}

// NewDevice baut ein minimales, gültiges Device-Resource unterhalb von nodeID.
func NewDevice(id, label, nodeID string, senderIDs, receiverIDs []string) Device {
	return Device{
		ID:          id,
		Version:     nowVersion(),
		Label:       label,
		Description: "",
		Tags:        map[string][]string{},
		Type:        "urn:x-nmos:device:generic",
		NodeID:      nodeID,
		Senders:     senderIDs,
		Receivers:   receiverIDs,
		Controls:    []any{},
	}
}

// NewSender baut ein minimales, gültiges Sender-Resource unterhalb von deviceID.
func NewSender(id, label, deviceID string) Sender {
	return Sender{
		ID:                id,
		Version:           nowVersion(),
		Label:             label,
		Description:       "",
		Tags:              map[string][]string{},
		FlowID:            nil,
		Transport:         transportRTP,
		DeviceID:          deviceID,
		ManifestHref:      nil,
		InterfaceBindings: []string{interfaceName},
		Subscription:      SenderSubscription{ReceiverID: nil, Active: false},
	}
}

// NewReceiver baut ein minimales, gültiges (Video-)Receiver-Resource
// unterhalb von deviceID.
func NewReceiver(id, label, deviceID string) Receiver {
	return Receiver{
		ID:                id,
		Version:           nowVersion(),
		Label:             label,
		Description:       "",
		Tags:              map[string][]string{},
		DeviceID:          deviceID,
		Transport:         transportRTP,
		InterfaceBindings: []string{interfaceName},
		Subscription:      ReceiverSubscription{SenderID: nil, Active: false},
		Format:            formatVideo,
		Caps:              ReceiverCaps{MediaTypes: []string{"video/raw"}},
	}
}
