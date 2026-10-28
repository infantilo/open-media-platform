<?xml version="1.0" encoding="UTF-8"?>
<exchangePlaylist version="3.1">
    <properties>
        <channel name="TxX-A" timeOffset="Local" timeOffsetValue="01:00:00:00" txTime="2026-10-28T08:31:03:14"/>
        <status activeRegionSize="50" eventCount="5" focusIndex="1" listState="Primary Prepared|Primary Running|Primary OnAir"/>
        <timecode houseTime="2026-10-28T08:31:46:16" localTimeOffset="01:00:00:00"/>
    </properties>
    <eventList>
        <event type="PlaylistStart" enabled="true" uid="1">
            <state state="Done"/>
            <properties>
                <schedule endOffset="" startOffset="2026-10-28T08:30:00:00" startType="Sequential"/>
                <event houseId="H1" reconcileKey="KEY-0" title="Block eins"><classifications><classification category="Werbung" classification="EventType"/></classifications></event>
                <block name="B1"/>
            </properties>
        </event>
        <event type="PrimaryVideo" enabled="true" uid="2">
            <state schedStartTime="2026-10-28T08:31:03:14" schedEndTime="2026-10-28T08:32:03:24" state="Running"/>
            <properties>
                <schedule endOffset="00:01:00:14" endType="Duration" startOffset="2026-10-28T08:30:08:18" startType="Sequential"/>
                <mediaStream som="10:00:00:00"><video jobType="Play"/></mediaStream>
                <event reconcileKey="KEY-1" title="Beispielsendung"/>
                <switch rate="Fast" transition="Fade Cut"><source type="Auto"><auto type="MediaStream"/></source></switch>
                <media mediaName="MEDIA0001" mediaType="Video"/>
                <features>
                    <feature type="Loudness"><properties><genericPreset type="loudness"><preset name="LoudnessMild"/></genericPreset></properties></feature>
                    <feature type="Subtitle"><properties><media mediaName="10280930" mediaType="Subtitle"/></properties></feature>
                </features>
                <auxData><payload><field name="FeinplanId"><value>42</value></field></payload></auxData>
            </properties>
            <childEvents>
                <event type="LogoHD" enabled="true" uid="3">
                    <state schedStartTime="2026-10-28T08:31:03:14" schedEndTime="2026-10-28T08:32:03:24" state="Running"/>
                    <properties>
                        <schedule endOffset="00:00:00:00" endType="+ParentEnd" startOffset="00:00:00:00" startType="+ParentStart"/>
                        <media mediaName="transparent_720" mediaType="CG"/>
                    </properties>
                </event>
                <event type="VIZ" enabled="true" uid="4">
                    <state state="Initialised"/>
                    <properties>
                        <schedule endOffset="00:00:10:00" endType="-ParentEnd" startOffset="00:00:00:00" startType="+ParentStart"/>
                        <mediaStream><cg layer="Auto" type="Template"><f name="Titel">Ein Titel</f></cg></mediaStream>
                        <media mediaName="02700221" mediaType="CG"/>
                    </properties>
                </event>
            </childEvents>
        </event>
        <event type="Live" enabled="true" uid="5">
            <state schedStartTime="2026-10-28T09:00:00:00" schedEndTime="2026-10-28T09:09:23:03" state="Cued"/>
            <properties>
                <schedule endOffset="00:08:30:00" endType="Hold" startOffset="2026-10-28T09:00:00:00" startType="Fixed"/>
                <event reconcileKey="KEY-2" title="Live"/>
                <switch rate="Fast" transition="Cut">
                    <source type="Logical"><logical name="RP21"/></source>
                    <backupSource type="Logical"><logical name="DMX21"/></backupSource>
                </switch>
            </properties>
        </event>
        <event type="Comment" enabled="true" uid="6">
            <state state="Initialised"/>
            <properties><schedule startType="Sequential"/><event reconcileKey="6"><comment>RulesEngine: Validierungsproblem: [Media.Name] fehlt.</comment></event></properties>
        </event>
        <event type="PlaylistEnd" enabled="true" uid="7"><state state="Initialised"/><properties><schedule startType="Sequential"/></properties></event>
    </eventList>
</exchangePlaylist>
