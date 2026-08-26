import { ApiProperty } from '@nestjs/swagger';

/**
 * A single group in the response of `GET /savings/groups`, projected from
 * the `Group` read-model.
 *
 * `balance` is kept as a string (stroops) to avoid JS number precision loss
 * on large bigint values, consistent with `Balance.amount`.
 */
export class GroupListItemDto {
  @ApiProperty({ description: "The contract's identifier for this group" })
  on_chain_id: string;

  @ApiProperty({
    description:
      'Stellar account address of the group creator, or null if this group has only been observed via a group_split_settled event so far',
    nullable: true,
  })
  creator: string | null;

  @ApiProperty({
    description:
      'Group name, or null if this group has only been observed via a group_split_settled event so far',
    nullable: true,
  })
  name: string | null;

  @ApiProperty({
    description: 'Stellar account addresses of current group members',
    type: [String],
  })
  members: string[];

  @ApiProperty({
    description: 'Pooled balance held by the group, in stroops',
    example: '150000000',
  })
  balance: string;

  @ApiProperty({
    description: 'Whether the group is still open (accepting new members)',
  })
  open: boolean;
}

/**
 * Response shape for `GET /savings/groups?address=`.
 *
 * `groups` is filtered to only the groups where `address` is a current
 * member (`address = ANY(members)`).
 */
export class ListGroupsDto {
  @ApiProperty({
    description:
      'Stellar account address the groups are filtered by membership for',
  })
  address: string;

  @ApiProperty({
    description: 'Groups the address is a member of',
    type: [GroupListItemDto],
  })
  groups: GroupListItemDto[];
}
